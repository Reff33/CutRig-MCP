import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../utils/exec.js';
import { prepareOutputPath, resolveSafePath } from '../utils/safety.js';

export interface MediaProbe {
  path: string;
  formatName: string;
  durationSec: number;
  sizeBytes: number;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
  } | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
  } | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

function parseFps(rate?: string): number {
  if (!rate || rate === '0/0') return 0;
  const parts = rate.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    return den > 0 ? Number((num / den).toFixed(3)) : 0;
  }
  const val = Number(rate);
  return Number.isFinite(val) ? val : 0;
}

export async function probeMedia(inputPath: string, workspaceRoot?: string): Promise<MediaProbe> {
  const resolved = resolveSafePath(inputPath, workspaceRoot);
  const res = await runCommand(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', resolved],
    15_000
  );

  if (!res.ok) {
    throw new Error(`ffprobe failed for ${resolved}: ${res.stderr || 'unknown error'}`);
  }

  const parsed = JSON.parse(res.stdout) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: FfprobeStream[];
  };

  const streams = parsed.streams ?? [];
  const vStream = streams.find((s) => s.codec_type === 'video');
  const aStream = streams.find((s) => s.codec_type === 'audio');

  return {
    path: resolved,
    formatName: parsed.format?.format_name ?? 'unknown',
    durationSec: Number(parsed.format?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    video: vStream
      ? {
          codec: vStream.codec_name ?? 'unknown',
          width: vStream.width ?? 0,
          height: vStream.height ?? 0,
          fps: parseFps(vStream.avg_frame_rate) || parseFps(vStream.r_frame_rate)
        }
      : null,
    audio: aStream
      ? {
          codec: aStream.codec_name ?? 'unknown',
          sampleRate: Number(aStream.sample_rate ?? 0),
          channels: aStream.channels ?? 0
        }
      : null
  };
}

export async function trimClip(params: {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec?: number;
  durationSec?: number;
  reencode?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  workspaceRoot?: string;
}) {
  const input = resolveSafePath(params.inputPath, params.workspaceRoot);
  if (params.startSec < 0) throw new Error('startSec must be >= 0.');

  let duration = params.durationSec;
  if (params.endSec !== undefined) {
    if (params.endSec <= params.startSec) {
      throw new Error('endSec must be greater than startSec.');
    }
    duration = params.endSec - params.startSec;
  }
  if (duration === undefined || duration <= 0) {
    throw new Error('Provide either endSec (> startSec) or durationSec (> 0).');
  }

  const { outputPath, backupPath } = await prepareOutputPath(params.outputPath, [input], {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite,
    createDir: !params.dryRun
  });

  const args = [
    '-y',
    '-ss',
    String(params.startSec),
    '-i',
    input,
    '-t',
    String(duration),
    ...(params.reencode
      ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k']
      : ['-c', 'copy', '-avoid_negative_ts', 'make_zero']),
    outputPath
  ];

  if (params.dryRun) {
    return { dryRun: true, command: ['ffmpeg', ...args], outputPath, backupPath };
  }

  const res = await runCommand('ffmpeg', args, 180_000);
  if (!res.ok) throw new Error(`ffmpeg trim failed: ${res.stderr}`);

  const outProbe = await probeMedia(outputPath, params.workspaceRoot);
  return { dryRun: false, outputPath, backupPath, media: outProbe };
}

export async function concatClips(params: {
  inputPaths: string[];
  outputPath: string;
  width?: number;
  height?: number;
  fps?: number;
  transition?: 'none' | 'fade' | 'dissolve' | 'wipeleft' | 'wiperight' | 'slideleft';
  transitionDuration?: number;
  overwrite?: boolean;
  dryRun?: boolean;
  workspaceRoot?: string;
}) {
  if (params.inputPaths.length < 2) {
    throw new Error('concat requires at least 2 input clips.');
  }

  const probes = await Promise.all(
    params.inputPaths.map((p) => probeMedia(p, params.workspaceRoot))
  );
  const resolvedInputs = probes.map((p) => p.path);

  const firstVideo = probes.find((p) => p.video)?.video;
  if (!firstVideo) {
    throw new Error('At least one input clip must contain a video stream.');
  }

  const width = params.width ?? (firstVideo.width || 1280);
  const height = params.height ?? (firstVideo.height || 720);
  const fps = params.fps ?? Math.max(1, Math.round(firstVideo.fps || 30));
  const hasAnyAudio = probes.some((p) => p.audio !== null);

  const { outputPath, backupPath } = await prepareOutputPath(params.outputPath, resolvedInputs, {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite,
    createDir: !params.dryRun
  });

  const filterParts: string[] = [];
  for (let i = 0; i < probes.length; i++) {
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
    if (hasAnyAudio) {
      if (probes[i].audio) {
        filterParts.push(
          `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,aresample=async=1[a${i}]`
        );
      } else {
        const dur = Math.max(0.1, probes[i].durationSec || 1);
        filterParts.push(`anullsrc=r=48000:cl=stereo:d=${dur}[a${i}]`);
      }
    }
  }

  const transition = params.transition ?? 'none';
  const td = Math.min(2, Math.max(0.1, params.transitionDuration ?? 0.5));

  let videoOutLabel = '[vout]';
  let audioOutLabel = '[aout]';

  if (transition === 'none') {
    const concatInputs = probes
      .map((_, i) => (hasAnyAudio ? `[v${i}][a${i}]` : `[v${i}]`))
      .join('');
    filterParts.push(
      `${concatInputs}concat=n=${probes.length}:v=1:a=${hasAnyAudio ? 1 : 0}${hasAnyAudio ? '[vout][aout]' : '[vout]'}`
    );
  } else {
    let prevV = '[v0]';
    let prevA = '[a0]';
    let offset = Math.max(0.1, probes[0].durationSec - td);

    for (let i = 1; i < probes.length; i++) {
      const nextV = i === probes.length - 1 ? '[vout]' : `[vx${i}]`;
      filterParts.push(
        `${prevV}[v${i}]xfade=transition=${transition}:duration=${td}:offset=${offset.toFixed(3)}${nextV}`
      );
      prevV = nextV;

      if (hasAnyAudio) {
        const nextA = i === probes.length - 1 ? '[aout]' : `[ax${i}]`;
        filterParts.push(`${prevA}[a${i}]acrossfade=d=${td}${nextA}`);
        prevA = nextA;
      }

      offset = Math.max(0.1, offset + probes[i].durationSec - td);
    }
  }

  const args = [
    '-y',
    ...resolvedInputs.flatMap((inp) => ['-i', inp]),
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    videoOutLabel,
    ...(hasAnyAudio ? ['-map', audioOutLabel, '-c:a', 'aac', '-b:a', '192k'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    outputPath
  ];

  if (params.dryRun) {
    return { dryRun: true, command: ['ffmpeg', ...args], outputPath, backupPath };
  }

  const res = await runCommand('ffmpeg', args, 300_000);
  if (!res.ok) throw new Error(`ffmpeg concat failed: ${res.stderr}`);

  const outProbe = await probeMedia(outputPath, params.workspaceRoot);
  return { dryRun: false, outputPath, backupPath, media: outProbe };
}

const ASPECT_DIMS: Record<'16:9' | '9:16' | '1:1' | '4:5', { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 }
};

export async function reframeAspect(params: {
  inputPath: string;
  outputPath: string;
  aspect: '16:9' | '9:16' | '1:1' | '4:5';
  mode?: 'crop' | 'blur_pad';
  overwrite?: boolean;
  dryRun?: boolean;
  workspaceRoot?: string;
}) {
  const input = resolveSafePath(params.inputPath, params.workspaceRoot);
  const probe = await probeMedia(input, params.workspaceRoot);
  if (!probe.video) throw new Error('Input file has no video stream.');

  const { w, h } = ASPECT_DIMS[params.aspect];
  const mode = params.mode ?? 'crop';

  const { outputPath, backupPath } = await prepareOutputPath(params.outputPath, [input], {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite,
    createDir: !params.dryRun
  });

  const filterComplex =
    mode === 'crop'
      ? `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=yuv420p[vout]`
      : `[0:v]split=2[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bgblur];[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgfit];[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vout]`;

  const args = [
    '-y',
    '-i',
    input,
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    ...(probe.audio ? ['-map', '0:a', '-c:a', 'copy'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    outputPath
  ];

  if (params.dryRun) {
    return { dryRun: true, command: ['ffmpeg', ...args], outputPath, backupPath };
  }

  const res = await runCommand('ffmpeg', args, 240_000);
  if (!res.ok) throw new Error(`ffmpeg reframe failed: ${res.stderr}`);

  const outProbe = await probeMedia(outputPath, params.workspaceRoot);
  return { dryRun: false, outputPath, backupPath, media: outProbe };
}

export async function mixAudio(params: {
  videoPath: string;
  bgmPath?: string;
  outputPath: string;
  targetLufs?: number;
  bgmVolume?: number;
  ducking?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  workspaceRoot?: string;
}) {
  const video = resolveSafePath(params.videoPath, params.workspaceRoot);
  const bgm = params.bgmPath ? resolveSafePath(params.bgmPath, params.workspaceRoot) : undefined;
  const videoProbe = await probeMedia(video, params.workspaceRoot);

  if (!videoProbe.audio && !bgm) {
    throw new Error('Video has no audio stream and no bgmPath was provided.');
  }

  const lufs = params.targetLufs ?? -14;
  const bgmVol = params.bgmVolume ?? 0.18;
  const protectedInputs = bgm ? [video, bgm] : [video];

  const { outputPath, backupPath } = await prepareOutputPath(params.outputPath, protectedInputs, {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite,
    createDir: !params.dryRun
  });

  const args = ['-y', '-i', video];
  if (bgm) {
    args.push('-stream_loop', '-1', '-i', bgm);
  }

  if (videoProbe.audio && bgm) {
    const filter = params.ducking !== false
      ? `[0:a]loudnorm=I=${lufs}:TP=-1.5:LRA=11,asplit=2[main][sc];[1:a]volume=${bgmVol}[bgm];[bgm][sc]sidechaincompress=threshold=0.03:ratio=6:attack=25:release=300[ducked];[main][ducked]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      : `[0:a]loudnorm=I=${lufs}:TP=-1.5:LRA=11[main];[1:a]volume=${bgmVol}[bgm];[main][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
    args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]');
  } else if (videoProbe.audio) {
    args.push('-af', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`);
  } else {
    args.push(
      '-filter_complex',
      `[1:a]volume=${bgmVol},loudnorm=I=${lufs}:TP=-1.5:LRA=11[aout]`,
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-shortest'
    );
  }

  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', outputPath);

  if (params.dryRun) {
    return { dryRun: true, command: ['ffmpeg', ...args], outputPath, backupPath };
  }

  const res = await runCommand('ffmpeg', args, 240_000);
  if (!res.ok) throw new Error(`ffmpeg audio mix failed: ${res.stderr}`);

  const outProbe = await probeMedia(outputPath, params.workspaceRoot);
  return { dryRun: false, outputPath, backupPath, media: outProbe };
}

export async function extractPreviewFrames(params: {
  inputPath: string;
  outputDir: string;
  count?: number;
  maxWidth?: number;
  workspaceRoot?: string;
}) {
  const input = resolveSafePath(params.inputPath, params.workspaceRoot);
  const outDir = resolveSafePath(params.outputDir, params.workspaceRoot);
  const probe = await probeMedia(input, params.workspaceRoot);
  if (!probe.video) throw new Error('Input file has no video stream.');

  const count = Math.min(12, Math.max(1, params.count ?? 4));
  const maxWidth = Math.min(1920, Math.max(240, params.maxWidth ?? 640));
  const duration = Math.max(0.2, probe.durationSec || 1);

  await mkdir(outDir, { recursive: true });
  const files: string[] = [];

  // Fast keyframe seeking (-ss before -i) avoids decoding entire 4K videos
  await mapWithConcurrency(
    Array.from({ length: count }, (_, idx) => idx),
    4,
    async (idx) => {
      const seekSec = Math.max(0, Math.min(duration - 0.05, ((idx + 0.5) / count) * duration));
      const outPath = path.join(outDir, `frame_${String(idx + 1).padStart(2, '0')}.png`);
      const res = await runCommand(
        'ffmpeg',
        [
          '-y',
          '-ss',
          seekSec.toFixed(3),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          `scale=${maxWidth}:-2`,
          outPath
        ],
        30_000
      );
      if (!res.ok) throw new Error(`ffmpeg preview frame failed: ${res.stderr}`);
      files.push(outPath);
    }
  );

  files.sort();
  return { outputDir: outDir, count: files.length, files };
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function batchAnalyzeClips(params: {
  directory?: string;
  inputPaths?: string[];
  outputImagePath?: string;
  columns?: number;
  tileWidth?: number;
  samplePosition?: number;
  workspaceRoot?: string;
}) {
  let rawPaths: string[] = [];
  let defaultBaseDir: string | undefined;

  if (params.inputPaths && params.inputPaths.length > 0) {
    rawPaths = params.inputPaths.map((p) => resolveSafePath(p, params.workspaceRoot));
    defaultBaseDir = path.dirname(rawPaths[0]);
  } else if (params.directory) {
    const dir = resolveSafePath(params.directory, params.workspaceRoot);
    defaultBaseDir = dir;
    const entries = await readdir(dir, { withFileTypes: true });
    rawPaths = entries
      .filter((e) => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
  } else {
    throw new Error('Provide either directory or inputPaths.');
  }

  if (rawPaths.length === 0) {
    throw new Error('No video files found to analyze.');
  }

  const columns = Math.min(6, Math.max(1, params.columns ?? 4));
  const rawTileWidth = Math.min(640, Math.max(160, params.tileWidth ?? 320));
  const tileWidth = Math.floor(rawTileWidth / 2) * 2;
  const tileHeight = Math.max(90, Math.floor(((tileWidth * 9) / 16) / 2) * 2);
  const samplePos = Math.min(0.95, Math.max(0.05, params.samplePosition ?? 0.35));

  const sheetTarget =
    params.outputImagePath ?? path.join(defaultBaseDir!, '_cutrig_contact_sheet.jpg');
  const { outputPath: contactSheetPath } = await prepareOutputPath(sheetTarget, rawPaths, {
    workspaceRoot: params.workspaceRoot,
    overwrite: true,
    createDir: true
  });

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cutrig-sheet-'));
  try {
    const analyzed = await mapWithConcurrency(rawPaths, 6, async (clipPath, idx) => {
      const probe = await probeMedia(clipPath, params.workspaceRoot);
      const seekSec = Math.max(0, (probe.durationSec || 1) * samplePos);
      const thumbPath = path.join(tmpDir, `tile_${String(idx + 1).padStart(3, '0')}.jpg`);
      const vf = `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

      const res = await runCommand(
        'ffmpeg',
        ['-y', '-ss', seekSec.toFixed(3), '-i', clipPath, '-frames:v', '1', '-vf', vf, '-q:v', '4', thumbPath],
        30_000
      );
      if (!res.ok) {
        throw new Error(`ffmpeg thumbnail failed for ${clipPath}: ${res.stderr}`);
      }

      return {
        index: idx + 1,
        row: Math.floor(idx / columns) + 1,
        col: (idx % columns) + 1,
        name: path.basename(clipPath),
        path: clipPath,
        durationSec: probe.durationSec,
        width: probe.video?.width ?? 0,
        height: probe.video?.height ?? 0,
        fps: probe.video?.fps ?? 0,
        hasAudio: probe.audio !== null
      };
    });

    const rows = Math.ceil(analyzed.length / columns);
    const tileRes = await runCommand(
      'ffmpeg',
      [
        '-y',
        '-f',
        'image2',
        '-i',
        path.join(tmpDir, 'tile_%03d.jpg'),
        '-vf',
        `tile=${columns}x${rows}`,
        '-q:v',
        '3',
        contactSheetPath
      ],
      60_000
    );
    if (!tileRes.ok) {
      throw new Error(`ffmpeg contact sheet tile failed: ${tileRes.stderr}`);
    }

    return {
      clipCount: analyzed.length,
      contactSheetPath,
      grid: { columns, rows, order: 'left-to-right, top-to-bottom' },
      clips: analyzed
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function readPcmS16Mono(inputPath: string, sampleRate = 8000, maxSec = 300): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-t',
        String(maxSec),
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        's16le',
        'pipe:1'
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg PCM decode failed: ${Buffer.concat(errChunks).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function detectBeats(params: {
  inputPath: string;
  minGapSec?: number;
  maxBeats?: number;
  sensitivity?: number;
  workspaceRoot?: string;
}) {
  const input = resolveSafePath(params.inputPath, params.workspaceRoot);
  const probe = await probeMedia(input, params.workspaceRoot);
  if (!probe.audio) {
    throw new Error(`Input file has no audio stream: ${input}`);
  }

  const sampleRate = 8000;
  const frameSamples = 160; // 20 ms hop
  const frameSec = frameSamples / sampleRate;
  const minGapSec = params.minGapSec ?? 0.32;
  const maxBeats = params.maxBeats ?? 200;
  const thresholdMul = params.sensitivity ?? 1.65;

  const pcm = await readPcmS16Mono(input, sampleRate);
  const totalSamples = Math.floor(pcm.length / 2);
  const frameCount = Math.floor(totalSamples / frameSamples);
  if (frameCount < 4) {
    return {
      path: input,
      durationSec: probe.durationSec,
      estimatedBpm: null,
      beatCount: 0,
      beatsSec: [],
      intervalsSec: []
    };
  }

  const energies = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sumSq = 0;
    const base = f * frameSamples * 2;
    for (let i = 0; i < frameSamples; i++) {
      const s = pcm.readInt16LE(base + i * 2) / 32768;
      sumSq += s * s;
    }
    energies[f] = Math.sqrt(sumSq / frameSamples);
  }

  // Positive onset energy flux
  const flux = new Float64Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const diff = energies[f] - energies[f - 1];
    flux[f] = diff > 0 ? diff : 0;
  }

  const winRadius = 15; // +/-300 ms rolling mean window
  const beatsSec: number[] = [];
  let lastBeatTime = -minGapSec;

  for (let f = 1; f < frameCount - 1; f++) {
    if (flux[f] <= 0.01) continue;
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;

    const start = Math.max(0, f - winRadius);
    const end = Math.min(frameCount - 1, f + winRadius);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += flux[j];
    const localMean = sum / (end - start + 1);

    if (flux[f] >= localMean * thresholdMul) {
      const t = Number((f * frameSec).toFixed(3));
      if (t - lastBeatTime >= minGapSec) {
        beatsSec.push(t);
        lastBeatTime = t;
        if (beatsSec.length >= maxBeats) break;
      }
    }
  }

  const intervalsSec: number[] = [];
  for (let i = 1; i < beatsSec.length; i++) {
    intervalsSec.push(Number((beatsSec[i] - beatsSec[i - 1]).toFixed(3)));
  }

  let estimatedBpm: number | null = null;
  if (intervalsSec.length >= 2) {
    const sorted = [...intervalsSec].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) {
      let bpm = 60 / median;
      while (bpm < 70) bpm *= 2;
      while (bpm > 175) bpm /= 2;
      estimatedBpm = Math.round(bpm);
    }
  }

  return {
    path: input,
    durationSec: probe.durationSec,
    estimatedBpm,
    beatCount: beatsSec.length,
    beatsSec,
    intervalsSec: intervalsSec.slice(0, 40)
  };
}
