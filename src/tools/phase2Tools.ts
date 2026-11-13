import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { burnSubtitles, generateCaptions } from '../adapters/captions.js';
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
              volume: z.number().min(0).max(2).optional(),
              fadeInSec: z.number().min(0).optional().describe('Audio only: fade-in length in seconds'),
              fadeOutSec: z.number().min(0).optional().describe('Audio only: fade-out length in seconds')
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
        srtPath: z
          .string()
          .optional()
          .describe('Import every cue from an .srt file as text segments (merged with items)'),
        items: z
          .array(
            z.object({
              text: z.string(),
              startSec: z.number().min(0),
              durationSec: z.number().positive(),
              fontSize: z.number().positive().optional(),
              colorRgb: z
                .array(z.number().min(0).max(1))
                .length(3)
                .optional()
                .describe('RGB color as [r, g, b] in 0..1'),
              yOffset: z.number().optional()
            })
          )
          .min(1)
          .optional()
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

  server.registerTool(
    'cutrig_capcut_inspect_draft',
    {
      title: 'Inspect CapCut Draft Summary',
      description:
        'Return a compact ~1KB summary of a CapCut draft (tracks, filters, adjustment layers, clip counts, duration) without loading raw draft_content.json into context.',
      inputSchema: {
        draftPath: z.string().optional(),
        draftName: z.string().optional(),
        draftsDir: z.string().optional()
      }
    },
    async (args) => okJson(await inspectCapCutDraft(args))
  );

  server.registerTool(
    'cutrig_capcut_list_effects',
    {
      title: 'List CapCut Cached Effects',
      description:
        'List locally cached CapCut effect/filter/adjust bundles under Cache/effect in one fast call without shell searches.',
      inputSchema: {
        cacheDir: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async (args) => okJson(await listCapCutCachedEffects(args))
  );

  server.registerTool(
    'cutrig_capcut_restore_backup',
    {
      title: 'Restore CapCut Draft From Backup',
      description:
        'Undo a bad batch of draft edits by restoring draft_content.json / draft_meta_info.json from the newest .bak snapshot. Snapshots the current state first so the restore is reversible.',
      inputSchema: {
        draftPath: z.string().optional(),
        draftName: z.string().optional(),
        draftsDir: z.string().optional(),
        backupPath: z
          .string()
          .optional()
          .describe('Restore a specific .bak instead of the newest one')
      }
    },
    async (args) => okJson(await restoreCapCutBackup(args))
  );

  server.registerTool(
    'cutrig_capcut_validate_draft',
    {
      title: 'Validate CapCut Draft Health',
      description:
        'Read-only pre/post-flight check of a CapCut draft: dangling material refs, version-pair mismatch, text scale overflow, text starting inside a transition, empty tracks. Returns ok/errorCount/issues without opening CapCut.',
      inputSchema: {
        draftPath: z.string().optional(),
        draftName: z.string().optional(),
        draftsDir: z.string().optional(),
        textMinGapAfterTransitionSec: z.number().min(0).optional()
      }
    },
    async (args) => okJson(await validateCapCutDraft(args))
  );

  server.registerTool(
    'cutrig_capcut_color_grade',
    {
      title: 'Apply CapCut Color Grading',
      description:
        'Apply cinematic CapCut Adjustment tracks, RGB/Luma color_curves, and optional filter intensity in a single fast call with .bak backups.',
      inputSchema: {
        draftPath: z.string().optional(),
        draftName: z.string().optional(),
        draftsDir: z.string().optional(),
        preset: z
          .enum(['film', 'teal_orange', 'moody', 'warm_golden', 'clean_vivid'])
          .optional()
          .describe('Built-in cinematic color grading preset'),
        layerName: z.string().optional().describe('Adjustment layer name (default Adjust1; re-running updates idempotently)'),
        startSec: z.number().min(0).optional(),
        durationSec: z.number().positive().optional(),
        adjustments: z
          .object({
            temperature: z.number().min(-1).max(1).optional(),
            tone: z.number().min(-1).max(1).optional(),
            contrast: z.number().min(-1).max(1).optional(),
            highlight: z.number().min(-1).max(1).optional(),
            shadow: z.number().min(-1).max(1).optional(),
            white: z.number().min(-1).max(1).optional(),
            black: z.number().min(-1).max(1).optional(),
            saturation: z.number().min(-1).max(1).optional(),
            brightness: z.number().min(-1).max(1).optional(),
            sharpen: z.number().min(-1).max(1).optional(),
            fade: z.number().min(-1).max(1).optional(),
            vignette: z.number().min(-1).max(1).optional(),
            grain: z.number().min(-1).max(1).optional()
          })
          .optional()
          .describe('Custom slider overrides e.g. { temperature: 0.16, contrast: 0.12, highlight: -0.24, saturation: -0.1 }'),
        curves: z
          .object({
            luma: z.array(z.number().min(0).max(1)).min(4).optional(),
            red: z.array(z.number().min(0).max(1)).min(4).optional(),
            green: z.array(z.number().min(0).max(1)).min(4).optional(),
            blue: z.array(z.number().min(0).max(1)).min(4).optional()
          })
          .optional()
          .describe('Curve points as flat [x1,y1,x2,y2,...] pairs in 0..1 (flat form keeps Gemini proto schemas valid)'),
        filterName: z.string().optional().describe('Optional existing filter name to tune intensity on (e.g. Dunkirk)'),
        filterIntensity: z.number().min(0).max(1).optional()
      }
    },
    async (args) => okJson(await colorGradeCapCutDraft(args))
  );

  server.registerTool(
    'cutrig_capcut_adjust_timing',
    {
      title: 'Adjust CapCut Transitions & Text Timings',
      description:
        'Adjust transition durations (varied or uniform) and shift text segments to avoid overlapping transitions in CapCut draft with automatic .bak backup.',
      inputSchema: {
        draftPath: z.string().optional(),
        draftName: z.string().optional(),
        draftsDir: z.string().optional(),
        transitionDurations: z
          .array(z.number().positive())
          .optional()
          .describe('List of durations in seconds for each transition in sequence (e.g. [0.4, 0.6, 0.8, 1.0])'),
        transitionUniformSec: z
          .number()
          .positive()
          .optional()
          .describe('Uniform duration in seconds for all transitions (e.g. 0.5)'),
        transitionRandomRange: z
          .object({
            minSec: z.number().positive(),
            maxSec: z.number().positive()
          })
          .optional()
          .describe('Randomize or stagger transition durations across clips within [minSec, maxSec] (e.g. 0.4 to 1.0)'),
        shiftTextSec: z
          .number()
          .optional()
          .describe('Fixed offset in seconds to shift all text segments (e.g. +0.5)'),
        avoidTransitionsForTexts: z
          .boolean()
          .optional()
          .describe('Automatically shift text segments past transition zones so texts start after transitions end'),
        textMinGapAfterTransitionSec: z
          .number()
          .min(0)
          .optional()
          .describe('Safety margin in seconds after transition ends before text begins (default 0.2s)'),
        autoCloseCapCut: z
          .boolean()
          .optional()
          .describe('Automatically terminate running CapCut.exe process before mutation to avoid cache collision (default true)'),
        autoReopenCapCut: z
          .boolean()
          .optional()
          .describe('Automatically relaunch CapCut Desktop once mutation succeeds (default true)'),
        textSafeScale: z
          .number()
          .min(0.1)
          .max(0.8)
          .optional()
          .describe('Clamp text clip scale to this value (max 0.8) to prevent text clipping past 16:9 canvas edges (pyCapCut safe-scale)'),
        textYTransform: z
          .number()
          .min(-1)
          .max(1)
          .optional()
          .describe('Vertical transform offset for all text clips, e.g. 0.15 places text slightly below center above lower-third lyrics'),
        textFontSize: z
          .number()
          .positive()
          .optional()
          .describe('Override font_size on all text materials (e.g. 4.5-5.8 for long quotes)'),
        textAutoFit: z
          .boolean()
          .optional()
          .describe(
            'Derive each text block scale from its own longest line (pyCapCut bounding-box fit) instead of one constant; clamped to 0.4-0.8'
          ),
        textMaxWidthRatio: z
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe('Fraction of canvas width text may occupy when textAutoFit is on (default 0.9)'),
        textAdjustments: z
          .array(
            z.object({
              index: z.number().int().min(0).optional().describe('0-based text segment index'),
              startSec: z.number().min(0).optional(),
              durationSec: z.number().positive().optional()
            })
          )
          .optional()
          .describe('Specific surgical timing overrides per text segment')
      }
    },
    async (args) => okJson(await adjustCapCutTiming(args))
  );
}
