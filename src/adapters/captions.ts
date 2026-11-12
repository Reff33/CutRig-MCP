import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../utils/exec.js';
import { prepareOutputPath, resolveSafePath } from '../utils/safety.js';
import { probeMedia } from './ffmpeg.js';

export interface CaptionSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface WhisperBackend {
  available: boolean;
  engine: 'faster-whisper' | 'openai-whisper' | 'whisper-cli' | null;
  command: string | null;
  installHint: string;
}

export async function detectWhisperBackend(): Promise<WhisperBackend> {
  for (const bin of ['whisper-cli', 'whisper']) {
    const res = await runCommand(bin, ['--help'], 4000);
    if (res.ok) {
      return {
        available: true,
        engine: bin === 'whisper-cli' ? 'whisper-cli' : 'openai-whisper',
        command: bin,
        installHint: ''
      };
    }
  }

  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  const pyCheck = await runCommand(
    pyCmd,
    [
      '-I',
      '-c',
      "import importlib.util; print('fw' if importlib.util.find_spec('faster_whisper') else ('ow' if importlib.util.find_spec('whisper') else 'none'))"
    ],
    5000
  );
  if (pyCheck.ok && pyCheck.stdout === 'fw') {
    return { available: true, engine: 'faster-whisper', command: pyCmd, installHint: '' };
  }
  if (pyCheck.ok && pyCheck.stdout === 'ow') {
    return { available: true, engine: 'openai-whisper', command: pyCmd, installHint: '' };
  }

  return {
    available: false,
    engine: null,
    command: null,
    installHint:
      'Install a local Whisper engine: `pip install faster-whisper` (recommended) or `pip install openai-whisper`, or put `whisper-cli` (whisper.cpp) on PATH.'
  };
}

function formatSrtTime(sec: number): string {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const ms = msTotal % 1000;
  const s = Math.floor(msTotal / 1000) % 60;
  const m = Math.floor(msTotal / 60_000) % 60;
  const h = Math.floor(msTotal / 3_600_000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function formatAssTime(sec: number): string {
  const csTotal = Math.max(0, Math.round(sec * 100));
  const cs = csTotal % 100;
  const s = Math.floor(csTotal / 100) % 60;
  const m = Math.floor(csTotal / 6000) % 60;
  const h = Math.floor(csTotal / 360_000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

export function segmentsToSrt(segments: CaptionSegment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTime(seg.startSec)} --> ${formatSrtTime(seg.endSec)}\n${seg.text.trim()}\n`
    )
    .join('\n');
}

export function segmentsToAss(
  segments: CaptionSegment[],
  style: 'default' | 'tiktok_bold' | 'minimal' = 'tiktok_bold'
): string {
  const styleRow =
    style === 'tiktok_bold'
      ? 'Style: Default,Arial,58,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,140,1'
      : style === 'minimal'
        ? 'Style: Default,Arial,40,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,60,1'
        : 'Style: Default,Arial,46,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,80,1';

  const events = segments
    .map(
      (seg) =>
        `Dialogue: 0,${formatAssTime(seg.startSec)},${formatAssTime(seg.endSec)},Default,,0,0,0,,${seg.text.trim().replace(/\r?\n/g, '\\N')}`
    )
    .join('\n');

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleRow}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

export function escapeFfmpegFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function generateCaptions(params: {
  inputPath: string;
  outputSrtPath: string;
  outputAssPath?: string;
  model?: string;
  language?: string;
  style?: 'default' | 'tiktok_bold' | 'minimal';
  segmentsOverride?: CaptionSegment[];
  overwrite?: boolean;
  workspaceRoot?: string;
}) {
  const input = resolveSafePath(params.inputPath, params.workspaceRoot);
  let segments: CaptionSegment[] = [];
  let engineUsed = 'manual_segments';

  if (params.segmentsOverride && params.segmentsOverride.length > 0) {
    segments = params.segmentsOverride;
  } else {
    const backend = await detectWhisperBackend();
    if (!backend.available || !backend.command) {
      throw new Error(`No local Whisper engine found. ${backend.installHint}`);
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cutrig-whisper-'));
    try {
      const wavPath = path.join(tmpDir, 'audio_16k.wav');
      const extract = await runCommand(
        'ffmpeg',
        ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
        120_000
      );
      if (!extract.ok) {
        throw new Error(`Failed extracting audio for transcription: ${extract.stderr}`);
      }

      if (backend.engine === 'faster-whisper') {
        const pyScript = [
          'import json, sys',
          'from faster_whisper import WhisperModel',
          'wav_path, model_name, lang = sys.argv[1], sys.argv[2], sys.argv[3]',
          'model = WhisperModel(model_name, compute_type="int8")',
          'kw = {"language": lang} if lang else {}',
          'segs, _ = model.transcribe(wav_path, **kw)',
          'out = [{"startSec": round(s.start, 3), "endSec": round(s.end, 3), "text": s.text.strip()} for s in segs if s.text.strip()]',
          'print(json.dumps(out))'
        ].join('\n');
        const res = await runCommand(
          backend.command,
          ['-I', '-c', pyScript, wavPath, params.model ?? 'small', params.language ?? ''],
          300_000
        );
        if (!res.ok) throw new Error(`faster-whisper failed: ${res.stderr}`);
        segments = JSON.parse(res.stdout) as CaptionSegment[];
        engineUsed = 'faster-whisper';
      } else if (backend.engine === 'whisper-cli') {
        const outBase = path.join(tmpDir, 'out');
        const res = await runCommand(
          backend.command,
          [
            '-f',
            wavPath,
            '-osrt',
            '-of',
            outBase,
            ...(params.language ? ['-l', params.language] : [])
          ],
          300_000
        );
        if (!res.ok) throw new Error(`whisper-cli failed: ${res.stderr}`);
        const rawSrt = await readFile(`${outBase}.srt`, 'utf8');
        segments = parseSrt(rawSrt);
        engineUsed = 'whisper-cli';
      } else {
        const res = await runCommand(
          'whisper',
          [
            wavPath,
            '--model',
            params.model ?? 'small',
            '--output_format',
            'json',
            '--output_dir',
            tmpDir,
            ...(params.language ? ['--language', params.language] : [])
          ],
          300_000
        );
        if (!res.ok) throw new Error(`whisper CLI failed: ${res.stderr}`);
        const jsonRaw = await readFile(path.join(tmpDir, 'audio_16k.json'), 'utf8');
        const parsed = JSON.parse(jsonRaw) as {
          segments?: Array<{ start: number; end: number; text: string }>;
        };
        segments = (parsed.segments ?? []).map((s) => ({
          startSec: Number(s.start.toFixed(3)),
          endSec: Number(s.end.toFixed(3)),
          text: s.text.trim()
        }));
        engineUsed = 'openai-whisper';
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  const srtOut = await prepareOutputPath(params.outputSrtPath, [input], {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite
  });
  await writeFile(srtOut.outputPath, segmentsToSrt(segments), 'utf8');

  let assPath: string | null = null;
  if (params.outputAssPath) {
    const assOut = await prepareOutputPath(params.outputAssPath, [input], {
      workspaceRoot: params.workspaceRoot,
      overwrite: params.overwrite
    });
    await writeFile(assOut.outputPath, segmentsToAss(segments, params.style), 'utf8');
    assPath = assOut.outputPath;
  }

  return {
    engine: engineUsed,
    segmentCount: segments.length,
    srtPath: srtOut.outputPath,
    assPath,
    segments
  };
}

function parseSrtTime(stamp: string): number {
  const m = stamp.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function parseSrt(raw: string): CaptionSegment[] {
  const blocks = raw.trim().split(/\r?\n\r?\n+/);
  const out: CaptionSegment[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeLineIdx].split('-->');
    const text = lines.slice(timeLineIdx + 1).join('\n').trim();
    if (text) {
      out.push({
        startSec: parseSrtTime(startRaw),
        endSec: parseSrtTime(endRaw),
        text
      });
    }
  }
  return out;
}

export async function burnSubtitles(params: {
  inputPath: string;
  subtitlePath: string;
  outputPath: string;
  overwrite?: boolean;
  dryRun?: boolean;
  workspaceRoot?: string;
}) {
  const input = resolveSafePath(params.inputPath, params.workspaceRoot);
  const sub = resolveSafePath(params.subtitlePath, params.workspaceRoot);
  const probe = await probeMedia(input, params.workspaceRoot);
  if (!probe.video) throw new Error('Input file has no video stream.');

  const { outputPath, backupPath } = await prepareOutputPath(params.outputPath, [input, sub], {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite,
    createDir: !params.dryRun
  });

  const ext = path.extname(sub).toLowerCase();
  const escaped = escapeFfmpegFilterPath(sub);
  const vf = ext === '.ass' || ext === '.ssa' ? `ass='${escaped}'` : `subtitles='${escaped}'`;

  const args = [
    '-y',
    '-i',
    input,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    ...(probe.audio ? ['-c:a', 'copy'] : []),
    '-movflags',
    '+faststart',
    outputPath
  ];

  if (params.dryRun) {
    return { dryRun: true, command: ['ffmpeg', ...args], outputPath, backupPath };
  }

  const res = await runCommand('ffmpeg', args, 240_000);
  if (!res.ok) throw new Error(`ffmpeg burn subtitles failed: ${res.stderr}`);

  const outProbe = await probeMedia(outputPath, params.workspaceRoot);
  return { dryRun: false, outputPath, backupPath, media: outProbe };
}
