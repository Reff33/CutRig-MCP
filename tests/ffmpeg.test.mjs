import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCutRigServer } from '../dist/server.js';
import {
  concatClips,
  extractPreviewFrames,
  mixAudio,
  probeMedia,
  reframeAspect,
  trimClip
} from '../dist/adapters/ffmpeg.js';

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test('MCP server registers all Phase 1 FFmpeg tools', async () => {
  const server = createCutRigServer();
  const client = new Client({ name: 'cutrig-phase1-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    'cutrig_doctor',
    'cutrig_probe_media',
    'cutrig_trim',
    'cutrig_concat',
    'cutrig_reframe',
    'cutrig_audio_mix',
    'cutrig_preview_frames'
  ]) {
    assert.ok(names.includes(expected), `Missing tool: ${expected}`);
  }

  await Promise.all([client.close(), server.close()]);
});

test(
  'FFmpeg adapter end-to-end (probe, trim, concat with silent+audio mix, reframe, audio_mix, preview_frames)',
  { skip: !hasFfmpeg() },
  async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cutrig-lavfi-'));
    try {
      const clipA = path.join(tmp, 'clip_a.mp4');
      const clipSilent = path.join(tmp, 'clip_silent.mp4');
      const bgm = path.join(tmp, 'bgm.wav');

      // Generate synthetic 2s video+audio clip (640x360, 30fps)
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-shortest',
          clipA
        ],
        { stdio: 'ignore', windowsHide: true }
      );

      // Generate synthetic 1.5s video-only clip (like KinetRig silent render)
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f', 'lavfi', '-i', 'color=c=blue:size=640x360:rate=30:duration=1.5',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          clipSilent
        ],
        { stdio: 'ignore', windowsHide: true }
      );

      // Generate synthetic 2s BGM wav
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=2',
          bgm
        ],
        { stdio: 'ignore', windowsHide: true }
      );

      // 1. Probe
      const probed = await probeMedia(clipA, tmp);
      assert.equal(probed.video?.width, 640);
      assert.equal(probed.video?.height, 360);
      assert.ok(probed.audio !== null);
      assert.ok(probed.durationSec >= 1.8 && probed.durationSec <= 2.2);

      // 2. Trim dryRun + actual + collision auto-suffix
      const trimmedPath = path.join(tmp, 'trimmed.mp4');
      const dry = await trimClip({
        inputPath: clipA,
        outputPath: trimmedPath,
        startSec: 0.5,
        durationSec: 1.0,
        dryRun: true,
        workspaceRoot: tmp
      });
      assert.equal(dry.dryRun, true);
      assert.equal(existsSync(trimmedPath), false);

      const trim1 = await trimClip({
        inputPath: clipA,
        outputPath: trimmedPath,
        startSec: 0.5,
        durationSec: 1.0,
        reencode: true,
        workspaceRoot: tmp
      });
      assert.equal(trim1.outputPath, trimmedPath);
      assert.ok(trim1.media.durationSec >= 0.85 && trim1.media.durationSec <= 1.2);

      const trim2 = await trimClip({
        inputPath: clipA,
        outputPath: trimmedPath,
        startSec: 0,
        durationSec: 1.0,
        workspaceRoot: tmp
      });
      assert.equal(trim2.outputPath, path.join(tmp, 'trimmed_1.mp4'));

      // 3. Concat mixed audio + silent clip with fade xfade
      const mergedPath = path.join(tmp, 'merged.mp4');
      const merged = await concatClips({
        inputPaths: [clipSilent, clipA],
        outputPath: mergedPath,
        width: 640,
        height: 360,
        fps: 30,
        transition: 'fade',
        transitionDuration: 0.3,
        workspaceRoot: tmp
      });
      assert.equal(merged.media.video?.width, 640);
      assert.equal(merged.media.video?.height, 360);
      assert.ok(merged.media.audio !== null);
      assert.ok(merged.media.durationSec >= 2.8);

      // 4. Reframe 16:9 -> 9:16 blur_pad
      const verticalPath = path.join(tmp, 'vertical.mp4');
      const reframed = await reframeAspect({
        inputPath: clipA,
        outputPath: verticalPath,
        aspect: '9:16',
        mode: 'blur_pad',
        workspaceRoot: tmp
      });
      assert.equal(reframed.media.video?.width, 1080);
      assert.equal(reframed.media.video?.height, 1920);

      // 5. Audio mix with BGM + ducking
      const mixedPath = path.join(tmp, 'mixed.mp4');
      const mixed = await mixAudio({
        videoPath: clipA,
        bgmPath: bgm,
        outputPath: mixedPath,
        bgmVolume: 0.2,
        ducking: true,
        workspaceRoot: tmp
      });
      assert.ok(mixed.media.audio !== null);

      // 6. Preview frames
      const previewDir = path.join(tmp, 'frames');
      const frames = await extractPreviewFrames({
        inputPath: clipA,
        outputDir: previewDir,
        count: 3,
        maxWidth: 320,
        workspaceRoot: tmp
      });
      assert.equal(frames.count, 3);
      assert.ok(frames.files.every((f) => existsSync(f)));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
);
