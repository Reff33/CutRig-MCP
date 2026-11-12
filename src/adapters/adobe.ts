import { mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../utils/exec.js';
import { fileExists, prepareOutputPath, resolveSafePath } from '../utils/safety.js';

export interface AdobeEnvironment {
  supportedOnOs: boolean;
  premiereProDirs: string[];
  afterEffectsDirs: string[];
  aerenderPath: string | null;
  note: string;
}

export async function detectAdobeEnvironment(
  platform: NodeJS.Platform = process.platform
): Promise<AdobeEnvironment> {
  if (platform === 'linux') {
    return {
      supportedOnOs: false,
      premiereProDirs: [],
      afterEffectsDirs: [],
      aerenderPath: null,
      note: 'Adobe Premiere Pro & After Effects are unavailable on Linux; route edits through FFmpeg or DaVinci Resolve.'
    };
  }

  const premiereProDirs: string[] = [];
  const afterEffectsDirs: string[] = [];
  let aerenderPath: string | null = null;

  if (platform === 'win32') {
    const adobeRoot = path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Adobe');
    if (await fileExists(adobeRoot)) {
      const entries = await readdir(adobeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(adobeRoot, entry.name);
        if (/^Adobe Premiere Pro/i.test(entry.name)) {
          premiereProDirs.push(full);
        } else if (/^Adobe After Effects/i.test(entry.name)) {
          afterEffectsDirs.push(full);
          const candidate = path.join(full, 'Support Files', 'aerender.exe');
          if (!aerenderPath && (await fileExists(candidate))) {
            aerenderPath = candidate;
          }
        }
      }
    }
  } else if (platform === 'darwin') {
    const appsDir = '/Applications';
    if (await fileExists(appsDir)) {
      const entries = await readdir(appsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(appsDir, entry.name);
        if (/^Adobe Premiere Pro/i.test(entry.name)) {
          premiereProDirs.push(full);
        } else if (/^Adobe After Effects/i.test(entry.name)) {
          afterEffectsDirs.push(full);
          const candidate = path.join(full, 'aerender');
          if (!aerenderPath && (await fileExists(candidate))) {
            aerenderPath = candidate;
          }
        }
      }
    }
  }

  return {
    supportedOnOs: true,
    premiereProDirs: premiereProDirs.sort().reverse(),
    afterEffectsDirs: afterEffectsDirs.sort().reverse(),
    aerenderPath,
    note:
      premiereProDirs.length || afterEffectsDirs.length
        ? 'Adobe applications detected.'
        : 'No local Adobe Premiere Pro or After Effects installation detected.'
  };
}

export type PremiereAction = 'import_media' | 'add_marker' | 'apply_mogrt' | 'export_sequence';

export function buildPremiereExtendScript(params: {
  action: PremiereAction;
  mediaPaths?: string[];
  markerTimeSec?: number;
  markerLabel?: string;
  mogrtPath?: string;
  outputPath?: string;
  presetPath?: string;
}): string {
  const esc = (val: string) => JSON.stringify(val.replace(/\\/g, '/'));

  switch (params.action) {
    case 'import_media': {
      const list = JSON.stringify((params.mediaPaths ?? []).map((p) => p.replace(/\\/g, '/')));
      return [
        'var files = ' + list + ';',
        'if (app.project) {',
        '  app.project.importFiles(files, true, app.project.rootItem, false);',
        '}'
      ].join('\n');
    }
    case 'add_marker':
      return [
        'var seq = app.project ? app.project.activeSequence : null;',
        'if (!seq) throw new Error("No active Premiere sequence.");',
        `var m = seq.markers.createMarker(${Number(params.markerTimeSec ?? 0)});`,
        `m.name = ${esc(params.markerLabel ?? 'CutRig Marker')};`
      ].join('\n');
    case 'apply_mogrt':
      return [
        'var seq = app.project ? app.project.activeSequence : null;',
        'if (!seq) throw new Error("No active Premiere sequence.");',
        `seq.importMGT(${esc(params.mogrtPath ?? '')}, ${Number(params.markerTimeSec ?? 0)}, 1, 0);`
      ].join('\n');
    case 'export_sequence':
      return [
        'var seq = app.project ? app.project.activeSequence : null;',
        'if (!seq) throw new Error("No active Premiere sequence.");',
        `seq.exportAsMediaDirect(${esc(params.outputPath ?? '')}, ${esc(params.presetPath ?? '')}, 1);`
      ].join('\n');
  }
}

export async function runPremiereAction(params: {
  action: PremiereAction;
  mediaPaths?: string[];
  markerTimeSec?: number;
  markerLabel?: string;
  mogrtPath?: string;
  outputPath?: string;
  presetPath?: string;
  outputScriptPath?: string;
  dryRun?: boolean;
  workspaceRoot?: string;
  platformOverride?: NodeJS.Platform;
}) {
  const platform = params.platformOverride ?? process.platform;
  const env = await detectAdobeEnvironment(platform);
  if (!env.supportedOnOs) {
    return {
      supported: false,
      skipped: true,
      fallback: 'ffmpeg',
      reason: env.note
    };
  }

  const safeMedia = (params.mediaPaths ?? []).map((p) =>
    resolveSafePath(p, params.workspaceRoot)
  );
  const safeMogrt = params.mogrtPath
    ? resolveSafePath(params.mogrtPath, params.workspaceRoot)
    : undefined;
  const safeOutput = params.outputPath
    ? resolveSafePath(params.outputPath, params.workspaceRoot)
    : undefined;
  const safePreset = params.presetPath
    ? resolveSafePath(params.presetPath, params.workspaceRoot)
    : undefined;

  const jsx = buildPremiereExtendScript({
    action: params.action,
    mediaPaths: safeMedia,
    markerTimeSec: params.markerTimeSec,
    markerLabel: params.markerLabel,
    mogrtPath: safeMogrt,
    outputPath: safeOutput,
    presetPath: safePreset
  });

  if (params.dryRun) {
    return {
      supported: true,
      dryRun: true,
      premiereInstalled: env.premiereProDirs.length > 0,
      action: params.action,
      jsx
    };
  }

  const scriptTarget = params.outputScriptPath
    ? resolveSafePath(params.outputScriptPath, params.workspaceRoot)
    : path.join(os.tmpdir(), `cutrig_premiere_${Date.now()}.jsx`);
  await mkdir(path.dirname(scriptTarget), { recursive: true });
  await writeFile(scriptTarget, jsx, 'utf8');

  return {
    supported: true,
    dryRun: false,
    premiereInstalled: env.premiereProDirs.length > 0,
    action: params.action,
    scriptPath: scriptTarget,
    jsx,
    nextStep:
      'Execute via Adobe UXP / adobe-mcp bridge or Premiere File -> Scripts (or launch via ExtendScript Toolkit / VS Code ExtendScript Debugger).'
  };
}

export async function renderAfterEffects(params: {
  aepPath: string;
  compName: string;
  outputPath: string;
  rsTemplate?: string;
  omTemplate?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  workspaceRoot?: string;
  platformOverride?: NodeJS.Platform;
}) {
  const platform = params.platformOverride ?? process.platform;
  const env = await detectAdobeEnvironment(platform);
  if (!env.supportedOnOs) {
    return {
      supported: false,
      skipped: true,
      fallback: 'ffmpeg',
      reason: env.note
    };
  }

  const aep = resolveSafePath(params.aepPath, params.workspaceRoot);
  const { outputPath, backupPath } = await prepareOutputPath(params.outputPath, [aep], {
    workspaceRoot: params.workspaceRoot,
    overwrite: params.overwrite,
    createDir: !params.dryRun
  });

  const aerenderBin = env.aerenderPath ?? 'aerender';
  const args = [
    '-project',
    aep,
    '-comp',
    params.compName,
    '-output',
    outputPath,
    ...(params.rsTemplate ? ['-RStemplate', params.rsTemplate] : []),
    ...(params.omTemplate ? ['-OMtemplate', params.omTemplate] : [])
  ];

  if (params.dryRun) {
    return {
      supported: true,
      dryRun: true,
      aerenderInstalled: env.aerenderPath !== null,
      command: [aerenderBin, ...args],
      outputPath,
      backupPath
    };
  }

  if (!env.aerenderPath) {
    throw new Error(
      'After Effects `aerender` binary was not found. Install Adobe After Effects or use FFmpeg/KinetRig lane.'
    );
  }

  const res = await runCommand(env.aerenderPath, args, 600_000);
  if (!res.ok) {
    throw new Error(`aerender failed: ${res.stderr || res.stdout}`);
  }

  return {
    supported: true,
    dryRun: false,
    outputPath,
    backupPath,
    stdout: res.stdout
  };
}
