import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCutRigServer } from '../dist/server.js';
import { burnSubtitles, generateCaptions, parseSrt } from '../dist/adapters/captions.js';
import {
  addTextToCapCutDraft,
  adjustCapCutTiming,
  colorGradeCapCutDraft,
  createCapCutDraft,
  insertClipsToCapCutDraft,
  inspectCapCutDraft,
  listCapCutCachedAudio,
  listCapCutCachedEffects,
  listCapCutDrafts,
  restoreCapCutBackup,
  validateCapCutDraft
} from '../dist/adapters/capcut.js';

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test('MCP server registers all Phase 2 caption & CapCut tools', async () => {
  const server = createCutRigServer();
  const client = new Client({ name: 'cutrig-phase2-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);

  for (const expected of [
    'cutrig_auto_captions',
    'cutrig_burn_subtitles',
    'cutrig_capcut_list_drafts',
    'cutrig_capcut_create_draft',
    'cutrig_capcut_insert_clips',
    'cutrig_capcut_add_text',
    'cutrig_capcut_list_audio',
    'cutrig_capcut_inspect_draft',
    'cutrig_capcut_list_effects',
    'cutrig_capcut_color_grade',
    'cutrig_capcut_adjust_timing'
  ]) {
    assert.ok(names.includes(expected), `Missing Phase 2 tool: ${expected}`);
  }

  await Promise.all([client.close(), server.close()]);
});

test('All tool input schemas are Gemini/proto-safe (no tuple-style array items)', async () => {
  const server = createCutRigServer();
  const client = new Client({ name: 'cutrig-schema-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();

  const offenders = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.items)) offenders.push(`${path}.items (tuple array form)`);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'items' && Array.isArray(value)) continue;
      walk(value, `${path}.${key}`);
    }
  };

  for (const tool of tools) {
    walk(tool.inputSchema, tool.name);
  }

  assert.deepEqual(offenders, [], `Gemini rejects these schemas: ${offenders.join(', ')}`);
  await Promise.all([client.close(), server.close()]);
});

test(
  'Captions (.srt/.ass generation + FFmpeg burn) and CapCut draft JSON lifecycle with .bak snapshots',
  { skip: !hasFfmpeg() },
  async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cutrig-p2-'));
    try {
      const clip = path.join(tmp, 'sample.mp4');
      const audio = path.join(tmp, 'vo.wav');

      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-shortest',
          clip
        ],
        { stdio: 'ignore', windowsHide: true }
      );

      execFileSync(
        'ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=1.5', audio],
        { stdio: 'ignore', windowsHide: true }
      );

      // 1. Generate SRT + ASS from segments
      const srtPath = path.join(tmp, 'subs.srt');
      const assPath = path.join(tmp, 'subs.ass');
      const capRes = await generateCaptions({
        inputPath: clip,
        outputSrtPath: srtPath,
        outputAssPath: assPath,
        style: 'tiktok_bold',
        segmentsOverride: [
          { startSec: 0, endSec: 1.0, text: 'First line' },
          { startSec: 1.0, endSec: 2.0, text: 'Second line' }
        ],
        workspaceRoot: tmp
      });

      assert.equal(capRes.segmentCount, 2);
      assert.equal(existsSync(srtPath), true);
      assert.equal(existsSync(assPath), true);
      const parsed = parseSrt(readFileSync(srtPath, 'utf8'));
      assert.equal(parsed.length, 2);
      assert.equal(parsed[1].text, 'Second line');

      // 2. Burn subtitles onto synthetic video
      const burnedPath = path.join(tmp, 'burned.mp4');
      const burned = await burnSubtitles({
        inputPath: clip,
        subtitlePath: assPath,
        outputPath: burnedPath,
        workspaceRoot: tmp
      });
      assert.equal(existsSync(burned.outputPath), true);
      assert.equal(burned.media.video?.width, 640);

      // 3. CapCut Draft lifecycle (including root_meta_info.json registration + sibling platform profile)
      const draftsRoot = path.join(tmp, 'capcut_drafts');
      const siblingDir = path.join(draftsRoot, 'existing_app_draft');
      mkdirSync(siblingDir, { recursive: true });
      writeFileSync(
        path.join(siblingDir, 'draft_content.json'),
        JSON.stringify({
          id: 'SIBLING-1',
          platform: { os: 'windows', app_id: 359289, app_version: '9.5.0', device_id: 'dev-123' },
          last_modified_platform: { os: 'windows', app_id: 359289, app_version: '9.5.0', device_id: 'dev-123' },
          config: { video_mute: false, material_save_mode: 0 }
        }),
        'utf8'
      );
      writeFileSync(
        path.join(draftsRoot, 'root_meta_info.json'),
        JSON.stringify({ all_draft_store: [], draft_ids: 0, root_path: draftsRoot }),
        'utf8'
      );
      const created = await createCapCutDraft({
        name: 'Promo_Test',
        draftsDir: draftsRoot,
        width: 1080,
        height: 1920,
        fps: 30
      });
      assert.equal(existsSync(path.join(created.draftPath, 'draft_content.json')), true);
      assert.equal(existsSync(path.join(created.draftPath, 'draft_settings')), true);

      const listed = await listCapCutDrafts(draftsRoot);
      assert.equal(listed.drafts.length, 2);
      assert.ok(listed.drafts.some((d) => d.name === 'Promo_Test'));

      const inserted = await insertClipsToCapCutDraft({
        draftPath: created.draftPath,
        clips: [
          { path: clip, trackType: 'video' },
          { path: audio, trackType: 'audio', startSec: 0, volume: 0.8, fadeInSec: 0.3, fadeOutSec: 0.5 }
        ]
      });
      assert.equal(inserted.insertedCount, 2);
      assert.ok(inserted.totalDurationSec >= 1.9);
      assert.ok(inserted.backups.length >= 1);

      // Audio fades live in a companion audio_fade material referenced from the segment.
      const fadeContent = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      assert.equal(fadeContent.materials.audio_fades.length, 1);
      const fadeMat = fadeContent.materials.audio_fades[0];
      assert.equal(fadeMat.fade_in_duration, 300000);
      assert.equal(fadeMat.fade_out_duration, 500000);
      const audioSeg = fadeContent.tracks.find((t) => t.type === 'audio').segments[0];
      assert.ok(audioSeg.extra_material_refs.includes(fadeMat.id));

      const addedText = await addTextToCapCutDraft({
        draftPath: created.draftPath,
        items: [{ text: 'CutRig Ready', startSec: 0.2, durationSec: 1.5 }]
      });
      assert.equal(addedText.addedCount, 1);

      const draftFiles = readdirSync(created.draftPath);
      assert.ok(draftFiles.some((f) => f.endsWith('.bak')));

      const content = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      // app_version is pinned to the installed CapCut build (sibling only as fallback), but both
      // platform records must always agree — an inconsistent pair is what triggers CapCut's
      // "requires the latest app version" dialog.
      assert.ok(content.platform.app_version);
      assert.equal(content.platform.app_version, content.last_modified_platform.app_version);
      assert.equal(content.platform.device_id, 'dev-123');
      assert.equal(content.render_index_track_mode_on, true);
      assert.equal(content.materials.videos.length, 1);
      assert.equal(content.materials.audios.length, 1);
      assert.equal(content.materials.texts.length, 1);
      assert.equal(content.tracks.find((t) => t.type === 'video').segments.length, 1);
      assert.equal(content.tracks.find((t) => t.type === 'text').segments.length, 1);

      const draftMeta = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_meta_info.json'), 'utf8')
      );
      assert.equal(draftMeta.draft_new_version, '');
      assert.equal(draftMeta.draft_materials.find((m) => m.type === 0).value.length, 2);

      const rootMeta = JSON.parse(readFileSync(path.join(draftsRoot, 'root_meta_info.json'), 'utf8'));
      assert.equal(rootMeta.all_draft_store.length, 1);
      assert.equal(rootMeta.all_draft_store[0].draft_name, 'Promo_Test');
      assert.equal(rootMeta.all_draft_store[0].draft_new_version, '');
      assert.equal(rootMeta.all_draft_store[0].draft_root_path.includes('\\'), false);
      assert.ok(rootMeta.all_draft_store[0].tm_duration >= 1_900_000);

      // 3b. Color grade & compact draft inspection
      const graded = await colorGradeCapCutDraft({
        draftPath: created.draftPath,
        preset: 'film'
      });
      assert.equal(graded.preset, 'film');
      assert.equal(graded.hasCurves, true);
      assert.ok(graded.appliedAdjustments.contrast > 0);

      const summary = await inspectCapCutDraft({ draftPath: created.draftPath });
      assert.equal(summary.counts.adjustLayers, 1);
      assert.equal(summary.adjustLayers[0].name, 'Adjust1');
      assert.equal(summary.adjustLayers[0].hasCurves, true);

      // Idempotent re-grade replaces Adjust1 rather than duplicating tracks
      await colorGradeCapCutDraft({
        draftPath: created.draftPath,
        preset: 'teal_orange'
      });
      const summary2 = await inspectCapCutDraft({ draftPath: created.draftPath });
      assert.equal(summary2.counts.adjustLayers, 1);

      // 3c. Cached effect scanner
      const effectCacheDir = path.join(tmp, 'capcut_effect_cache');
      const effSub = path.join(effectCacheDir, '7501974767453474064', 'hash123');
      mkdirSync(effSub, { recursive: true });
      writeFileSync(path.join(effSub, 'config.json'), JSON.stringify({ name: 'Film Adjust' }), 'utf8');
      const effectsList = await listCapCutCachedEffects({ cacheDir: effectCacheDir });
      assert.equal(effectsList.count, 1);
      assert.equal(effectsList.bundles[0].effectId, '7501974767453474064');

      // 3d. CapCut transition duration variation & text offset alignment
      // Add synthetic transition to test project
      const draftContentRaw = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      draftContentRaw.materials.transitions = [
        { id: 'TRANS-1', name: 'Pull In', type: 'transition', duration: 500000 }
      ];
      draftContentRaw.tracks.find((t) => t.type === 'video').segments[0].extra_material_refs.push('TRANS-1');
      writeFileSync(
        path.join(created.draftPath, 'draft_content.json'),
        JSON.stringify(draftContentRaw, null, 2),
        'utf8'
      );

      const adjusted = await adjustCapCutTiming({
        draftPath: created.draftPath,
        transitionDurations: [0.75],
        avoidTransitionsForTexts: true,
        textMinGapAfterTransitionSec: 0.3
      });
      assert.equal(adjusted.adjustedTransitionsCount, 1);
      assert.equal(adjusted.adjustedTransitions[0].newDurationSec, 0.75);
      assert.ok(adjusted.adjustedTextsCount >= 1);
      assert.ok(adjusted.adjustedTexts[0].newStartSec > 0.2);

      // 3d-2. Safe text scale + position + font size (prevents 16:9 clipping)
      const restyled = await adjustCapCutTiming({
        draftPath: created.draftPath,
        textSafeScale: 0.75,
        textYTransform: 0.15,
        textFontSize: 5.6
      });
      assert.ok(restyled.styledTextsCount >= 1);
      const restyledContent = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      const restyledSeg = restyledContent.tracks.find((t) => t.type === 'text').segments[0];
      assert.equal(restyledSeg.clip.scale.x, 0.75);
      assert.equal(restyledSeg.clip.transform.y, 0.15);
      const restyledMat = restyledContent.materials.texts.find(
        (m) => m.id === restyledSeg.material_id
      );
      assert.equal(JSON.parse(restyledMat.content).styles[0].size, 5.6);
      assert.equal(restyled.textOverlapCount, restyled.textOverlaps.length);

      // 3d-3. autoFit derives scale per block from its longest line, never above the safe 0.8 ceiling
      const autofit = await adjustCapCutTiming({
        draftPath: created.draftPath,
        textAutoFit: true,
        textMaxWidthRatio: 0.9
      });
      const autofitContent = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      const autofitSeg = autofitContent.tracks.find((t) => t.type === 'text').segments[0];
      assert.ok(autofitSeg.clip.scale.x <= 0.8 && autofitSeg.clip.scale.x >= 0.4);
      assert.equal(autofitSeg.clip.scale.x, autofitSeg.clip.scale.y);
      assert.ok(autofit.styledTextsCount >= 1);

      // 3d-4. Read-only health check: clean draft reports ok, broken refs report an error
      const healthy = await validateCapCutDraft({ draftPath: created.draftPath });
      assert.equal(healthy.ok, true, JSON.stringify(healthy.issues));
      assert.equal(healthy.errorCount, 0);

      const brokenRaw = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      brokenRaw.tracks.find((t) => t.type === 'video').segments[0].material_id = 'MISSING-ID';
      writeFileSync(
        path.join(created.draftPath, 'draft_content.json'),
        JSON.stringify(brokenRaw, null, 2),
        'utf8'
      );
      const broken = await validateCapCutDraft({ draftPath: created.draftPath });
      assert.equal(broken.ok, false);
      assert.ok(broken.issues.some((i) => i.code === 'missing_material'));

      // 3d-5. Restore the newest .bak and the corruption is gone; the broken state is snapshotted first
      const restored = await restoreCapCutBackup({ draftPath: created.draftPath });
      assert.ok(restored.restoredContent, 'expected a content backup to restore');
      assert.ok(restored.undoSnapshot.length >= 1, 'expected a safety snapshot of the broken state');
      const restoredRaw = JSON.parse(
        readFileSync(path.join(created.draftPath, 'draft_content.json'), 'utf8')
      );
      assert.notEqual(
        restoredRaw.tracks.find((t) => t.type === 'video').segments[0].material_id,
        'MISSING-ID'
      );
      const afterRestore = await validateCapCutDraft({ draftPath: created.draftPath });
      assert.equal(afterRestore.ok, true, JSON.stringify(afterRestore.issues));

      // 4. CapCut cached audio & companion .beat parser
      const cacheMusicDir = path.join(tmp, 'capcut_cache_music');
      mkdirSync(cacheMusicDir, { recursive: true });
      const cachedMp3 = path.join(cacheMusicDir, 'abc123track.mp3');
      execFileSync(
        'ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', cachedMp3],
        { stdio: 'ignore', windowsHide: true }
      );
      writeFileSync(
        path.join(cacheMusicDir, 'abc123track.beat'),
        '{energy:[12.5,33.1,44.0],time:[500,1000,1500],value:[1,2,1]}',
        'utf8'
      );
      const cachedAudio = await listCapCutCachedAudio({ cacheDir: cacheMusicDir });
      assert.equal(cachedAudio.returnedCount, 1);
      assert.equal(cachedAudio.tracks[0].hasBeatFile, true);
      assert.equal(cachedAudio.tracks[0].beatCount, 3);
      assert.deepEqual(cachedAudio.tracks[0].downbeatsSec, [0.5, 1.5]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);
