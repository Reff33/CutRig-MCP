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
  createCapCutDraft,
  insertClipsToCapCutDraft,
  listCapCutCachedAudio,
  listCapCutDrafts
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
    'cutrig_capcut_list_audio'
  ]) {
    assert.ok(names.includes(expected), `Missing Phase 2 tool: ${expected}`);
  }

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

      // 3. CapCut Draft lifecycle (including root_meta_info.json registration)
      const draftsRoot = path.join(tmp, 'capcut_drafts');
      mkdirSync(draftsRoot, { recursive: true });
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

      const listed = await listCapCutDrafts(draftsRoot);
      assert.equal(listed.drafts.length, 1);
      assert.equal(listed.drafts[0].name, 'Promo_Test');

      const inserted = await insertClipsToCapCutDraft({
        draftPath: created.draftPath,
        clips: [
          { path: clip, trackType: 'video' },
          { path: audio, trackType: 'audio', startSec: 0, volume: 0.8 }
        ]
      });
      assert.equal(inserted.insertedCount, 2);
      assert.ok(inserted.totalDurationSec >= 1.9);
      assert.ok(inserted.backups.length >= 1);

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
      assert.equal(content.materials.videos.length, 1);
      assert.equal(content.materials.audios.length, 1);
      assert.equal(content.materials.texts.length, 1);
      assert.equal(content.tracks.find((t) => t.type === 'video').segments.length, 1);
      assert.equal(content.tracks.find((t) => t.type === 'text').segments.length, 1);

      const rootMeta = JSON.parse(readFileSync(path.join(draftsRoot, 'root_meta_info.json'), 'utf8'));
      assert.equal(rootMeta.all_draft_store.length, 1);
      assert.equal(rootMeta.all_draft_store[0].draft_name, 'Promo_Test');
      assert.ok(rootMeta.all_draft_store[0].tm_duration >= 1_900_000);

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
