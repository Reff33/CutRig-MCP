import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { detectAdobeEnvironment, type AdobeEnvironment } from '../adapters/adobe.js';
import { detectWhisperBackend, type WhisperBackend } from '../adapters/captions.js';
import { detectResolveEnvironment, type ResolveEnvironment } from '../adapters/resolve.js';
import { runCommand } from '../utils/exec.js';

export interface DoctorReport {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  ffmpeg: { available: boolean; version: string | null; encoders: string[] };
  ffprobe: { available: boolean; version: string | null };
  whisper: WhisperBackend;
  python: { available: boolean; command: string | null; version: string | null };
  adapters: {
    ffmpeg: boolean;
    capcutDrafts: { available: boolean; draftsDir: string | null };
    davinciResolve: ResolveEnvironment;
    adobe: AdobeEnvironment;
  };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function detectPython(): Promise<{ available: boolean; command: string | null; version: string | null }> {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    const res = await runCommand(cmd, ['--version'], 5000);
    if (res.ok) {
      return { available: true, command: cmd, version: res.stdout || res.stderr };
    }
  }
  return { available: false, command: null, version: null };
}

export async function getDoctorReport(): Promise<DoctorReport> {
  const [ffmpegVer, ffprobeVer, encodersOut, whisper, python, davinciResolve, adobe] =
    await Promise.all([
      runCommand('ffmpeg', ['-version'], 5000),
      runCommand('ffprobe', ['-version'], 5000),
      runCommand('ffmpeg', ['-hide_banner', '-encoders'], 5000),
      detectWhisperBackend(),
      detectPython(),
      detectResolveEnvironment(),
      detectAdobeEnvironment()
    ]);

  const wantedEncoders = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'libx264'];
  const encoders = encodersOut.ok
    ? wantedEncoders.filter((enc) => encodersOut.stdout.includes(enc))
    : [];

  let capcutDraftsDir: string | null = null;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(
      process.env.LOCALAPPDATA,
      'CapCut',
      'User Data',
      'Projects',
      'com.lveditor.draft'
    );
    if (await exists(candidate)) capcutDraftsDir = candidate;
  }

  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    ffmpeg: {
      available: ffmpegVer.ok,
      version: ffmpegVer.ok ? ffmpegVer.stdout.split(/\r?\n/)[0] ?? null : null,
      encoders
    },
    ffprobe: {
      available: ffprobeVer.ok,
      version: ffprobeVer.ok ? ffprobeVer.stdout.split(/\r?\n/)[0] ?? null : null
    },
    whisper,
    python,
    adapters: {
      ffmpeg: ffmpegVer.ok && ffprobeVer.ok,
      capcutDrafts: {
        available: capcutDraftsDir !== null,
        draftsDir: capcutDraftsDir
      },
      davinciResolve,
      adobe
    }
  };
}

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    'cutrig_doctor',
    {
      title: 'CutRig Environment Doctor',
      description:
        'Probe OS, FFmpeg/ffprobe, GPU encoders, Python, and available NLE adapters (CapCut, DaVinci Resolve, Adobe). Always run first before editing.',
      inputSchema: {
        verbose: z.boolean().optional().describe('Include detailed capability notes')
      }
    },
    async () => {
      const report = await getDoctorReport();
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
      };
    }
  );
}
