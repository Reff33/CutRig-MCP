import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { renderAfterEffects, runPremiereAction } from '../adapters/adobe.js';
import { runResolveAction } from '../adapters/resolve.js';

function okJson(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerPhase3Tools(server: McpServer): void {
  server.registerTool(
    'cutrig_resolve_action',
    {
      title: 'DaVinci Resolve Action',
      description:
        'Execute or dry-run DaVinci Resolve Scripting API actions (get_status, list_projects, create_timeline, import_media, render_timeline) on Windows & Linux.',
      inputSchema: {
        action: z.enum([
          'get_status',
          'list_projects',
          'create_timeline',
          'import_media',
          'render_timeline'
        ]),
        projectName: z.string().optional(),
        timelineName: z.string().optional(),
        mediaPaths: z.array(z.string()).optional(),
        presetName: z.string().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await runResolveAction(args))
  );

  server.registerTool(
    'cutrig_adobe_premiere',
    {
      title: 'Adobe Premiere Pro Bridge',
      description:
        'Generate or stage sandboxed ExtendScript (.jsx) automation for Premiere Pro (import_media, add_marker, apply_mogrt, export_sequence). Skips gracefully on Linux.',
      inputSchema: {
        action: z.enum(['import_media', 'add_marker', 'apply_mogrt', 'export_sequence']),
        mediaPaths: z.array(z.string()).optional(),
        markerTimeSec: z.number().min(0).optional(),
        markerLabel: z.string().optional(),
        mogrtPath: z.string().optional(),
        outputPath: z.string().optional(),
        presetPath: z.string().optional(),
        outputScriptPath: z.string().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await runPremiereAction(args))
  );

  server.registerTool(
    'cutrig_ae_render',
    {
      title: 'After Effects Headless Render',
      description:
        'Render an After Effects composition headlessly via aerender with non-destructive output protection. Skips gracefully on Linux.',
      inputSchema: {
        aepPath: z.string(),
        compName: z.string(),
        outputPath: z.string(),
        rsTemplate: z.string().optional(),
        omTemplate: z.string().optional(),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    },
    async (args) => okJson(await renderAfterEffects(args))
  );
}
