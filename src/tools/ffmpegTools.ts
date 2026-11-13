import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  batchAnalyzeClips,
  concatClips,
  detectBeats,
  extractPreviewFrames,
  mixAudio,
  probeMedia,
  reframeAspect,
  trimClip
} from '../adapters/ffmpeg.js';

function okJson(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerFfmpegTools(server: McpServer): void {
  server.registerTool(
    'cutrig_probe_media',
    {
      title: 'Probe Media Metadata',
      description:
        'Inspect video/audio streams, duration, resolution, FPS, and codec of a media file using ffprobe.',
      inputSchema: {
        inputPath: z.string().describe('Path to the media file')
      }
    },
    async ({ inputPath }) => okJson(await probeMedia(inputPath))
  );

  server.registerTool(
    'cutrig_trim',
    {
      title: 'Trim Clip',
      description:
        'Trim a video/audio clip by startSec + endSec or durationSec. Non-destructive by default (auto-suffixes if output exists).',
      inputSchema: {
        inputPath: z.string(),
        outputPath: z.string(),
        startSec: z.number().min(0),
        endSec: z.number().positive().optional(),
        durationSec: z.number().positive().optional(),
        reencode: z.boolean().optional().describe('True for frame-accurate re-encode; false for fast stream copy'),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await trimClip(args))
  );

  server.registerTool(
    'cutrig_concat',
    {
      title: 'Concatenate Clips',
      description:
        'Join 2+ video clips, normalizing resolution/FPS/audio streams, with optional xfade transitions.',
      inputSchema: {
        inputPaths: z.array(z.string()).min(2),
        outputPath: z.string(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().int().positive().optional(),
        transition: z
          .enum(['none', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft'])
          .optional(),
        transitionDuration: z.number().min(0.1).max(2).optional(),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await concatClips(args))
  );

  server.registerTool(
    'cutrig_reframe',
    {
      title: 'Reframe Aspect Ratio',
      description:
        'Convert a video between 16:9, 9:16, 1:1, and 4:5 using center crop or blurred background fill.',
      inputSchema: {
        inputPath: z.string(),
        outputPath: z.string(),
        aspect: z.enum(['16:9', '9:16', '1:1', '4:5']),
        mode: z.enum(['crop', 'blur_pad']).optional(),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await reframeAspect(args))
  );

  server.registerTool(
    'cutrig_audio_mix',
    {
      title: 'Mix & Normalize Audio',
      description:
        'Normalize primary audio to target LUFS and optionally blend/duck background music while keeping video untouched (-c:v copy).',
      inputSchema: {
        videoPath: z.string(),
        bgmPath: z.string().optional(),
        outputPath: z.string(),
        targetLufs: z.number().min(-30).max(-5).optional(),
        bgmVolume: z.number().min(0.01).max(1).optional(),
        ducking: z.boolean().optional(),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await mixAudio(args))
  );

  server.registerTool(
    'cutrig_preview_frames',
    {
      title: 'Extract Preview Frames',
      description:
        'Extract evenly spaced PNG keyframes from a video for visual QA before or after rendering.',
      inputSchema: {
        inputPath: z.string(),
        outputDir: z.string(),
        count: z.number().int().min(1).max(12).optional(),
        maxWidth: z.number().int().min(240).max(1920).optional()
      }
    },
    async (args) => okJson(await extractPreviewFrames(args))
  );

  server.registerTool(
    'cutrig_detect_beats',
    {
      title: 'Detect Audio Beats',
      description:
        'Analyze an audio/video file with FFmpeg PCM onset detection to return beat timestamps (seconds) and estimated BPM for beat-synced cuts and transitions.',
      inputSchema: {
        inputPath: z.string(),
        minGapSec: z.number().min(0.15).max(2).optional().describe('Minimum seconds between detected beats (default 0.32)'),
        maxBeats: z.number().int().min(1).max(500).optional(),
        sensitivity: z.number().min(1.1).max(4).optional().describe('Peak threshold multiplier (lower = more beats, default 1.65)')
      }
    },
    async (args) => okJson(await detectBeats(args))
  );

  server.registerTool(
    'cutrig_batch_analyze_clips',
    {
      title: 'Batch Analyze Clips & Contact Sheet',
      description:
        'Probe all video clips in a directory or path list in parallel and generate ONE labeled grid contact sheet image for rapid visual sequencing in a single Read call.',
      inputSchema: {
        directory: z.string().optional().describe('Folder containing video clips to scan'),
        inputPaths: z.array(z.string()).optional().describe('Explicit list of video file paths'),
        outputImagePath: z.string().optional().describe('Optional output contact sheet .jpg path'),
        columns: z.number().int().min(1).max(6).optional(),
        tileWidth: z.number().int().min(160).max(640).optional(),
        samplePosition: z.number().min(0.05).max(0.95).optional().describe('Relative timestamp 0.05-0.95 to sample each clip (default 0.35)')
      }
    },
    async (args) => okJson(await batchAnalyzeClips(args))
  );
}
