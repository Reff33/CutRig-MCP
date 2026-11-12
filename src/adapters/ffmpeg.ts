import { mkdir, readdir } from 'node:fs/promises';
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
  const fps = Number((count / duration).toFixed(4));

  await mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, 'frame_%02d.png');

  const res = await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i',
      input,
      '-vf',
      `fps=${fps},scale=${maxWidth}:-2`,
      '-frames:v',
      String(count),
      pattern
    ],
    60_000
  );

  if (!res.ok) throw new Error(`ffmpeg preview frames failed: ${res.stderr}`);

  const files = (await readdir(outDir))
    .filter((f) => /^frame_\d+\.png$/i.test(f))
    .sort()
    .map((f) => path.join(outDir, f));

  return { outputDir: outDir, count: files.length, files };
}
