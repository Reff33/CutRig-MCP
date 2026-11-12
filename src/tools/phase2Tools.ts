import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { burnSubtitles, generateCaptions } from '../adapters/captions.js';
import {
  addTextToCapCutDraft,
  createCapCutDraft,
  insertClipsToCapCutDraft,
  listCapCutCachedAudio,
  listCapCutDrafts
} from '../adapters/capcut.js';

function okJson(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerPhase2Tools(server: McpServer): void {
  server.registerTool(
    'cutrig_auto_captions',
    {
      title: 'Generate AI Captions',
      description:
        'Transcribe speech from video/audio via local Whisper (or provided segments) into .srt and optional styled .ass subtitles.',
      inputSchema: {
        inputPath: z.string(),
        outputSrtPath: z.string(),
        outputAssPath: z.string().optional(),
        model: z.string().optional().describe('Whisper model size e.g. tiny, base, small, medium'),
        language: z.string().optional().describe('ISO language code e.g. ms, en, id'),
        style: z.enum(['default', 'tiktok_bold', 'minimal']).optional(),
        segmentsOverride: z
          .array(
            z.object({
              startSec: z.number().min(0),
              endSec: z.number().positive(),
              text: z.string()
            })
          )
          .optional(),
        overwrite: z.boolean().optional()
      }
    },
    async (args) => okJson(await generateCaptions(args))
  );

  server.registerTool(
    'cutrig_burn_subtitles',
    {
      title: 'Burn Subtitles Into Video',
      description:
        'Render .srt or .ass subtitles directly onto a video track with safe Windows/Linux FFmpeg path escaping.',
      inputSchema: {
        inputPath: z.string(),
        subtitlePath: z.string(),
        outputPath: z.string(),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await burnSubtitles(args))
  );

  server.registerTool(
    'cutrig_capcut_list_drafts',
    {
      title: 'List CapCut Drafts',
      description: 'List local CapCut draft projects with duration, resolution, and track counts.',
      inputSchema: {
        draftsDir: z.string().optional()
      }
    },
    async ({ draftsDir }) => okJson(await listCapCutDrafts(draftsDir))
  );

  server.registerTool(
    'cutrig_capcut_create_draft',
    {
      title: 'Create CapCut Draft',
      description:
        'Create a new CapCut draft_content.json + draft_meta_info.json project folder with automatic .bak protection on overwrite.',
      inputSchema: {
        name: z.string(),
        draftsDir: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().int().positive().optional(),
        overwrite: z.boolean().optional()
      }
    },
    async (args) => okJson(await createCapCutDraft(args))
  );

  server.registerTool(
    'cutrig_capcut_insert_clips',
    {
      title: 'Insert Clips Into CapCut Draft',
      description:
        'Probe media clips and append them to video/audio tracks in a CapCut draft_content.json, creating a .bak snapshot first.',
      inputSchema: {
        draftPath: z.string(),
        clips: z
          .array(
            z.object({
              path: z.string(),
              trackType: z.enum(['video', 'audio']).optional(),
              startSec: z.number().min(0).optional(),
              trimStartSec: z.number().min(0).optional(),
              durationSec: z.number().positive().optional(),
              volume: z.number().min(0).max(2).optional()
            })
          )
          .min(1)
      }
    },
    async (args) => okJson(await insertClipsToCapCutDraft(args))
  );

  server.registerTool(
    'cutrig_capcut_add_text',
    {
      title: 'Add Text/Captions To CapCut Draft',
      description:
        'Insert timed text/subtitle segments onto the CapCut draft text track with automatic .bak backup.',
      inputSchema: {
        draftPath: z.string(),
        items: z
          .array(
            z.object({
              text: z.string(),
              startSec: z.number().min(0),
              durationSec: z.number().positive(),
              fontSize: z.number().positive().optional(),
              colorRgb: z.tuple([z.number(), z.number(), z.number()]).optional(),
              yOffset: z.number().optional()
            })
          )
          .min(1)
      }
    },
    async (args) => okJson(await addTextToCapCutDraft(args))
  );

  server.registerTool(
    'cutrig_capcut_list_audio',
    {
      title: 'List CapCut Cached Audio',
      description:
        'List locally cached/downloaded CapCut music tracks (.mp3/.wav) along with duration and companion .beat timestamps (if cached).',
      inputSchema: {
        cacheDir: z.string().optional().describe('Optional custom CapCut Cache/music directory'),
        limit: z.number().int().min(1).max(100).optional(),
        beatPreviewCount: z.number().int().min(5).max(200).optional()
      }
    },
    async (args) => okJson(await listCapCutCachedAudio(args))
  );
}
