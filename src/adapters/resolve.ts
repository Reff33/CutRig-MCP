import path from 'node:path';
import { runCommand } from '../utils/exec.js';
import { fileExists, resolveSafePath } from '../utils/safety.js';

export interface ResolveEnvironment {
  available: boolean;
  apiPath: string | null;
  libPath: string | null;
}

export function getResolvePaths(): { apiPath: string; libPath: string } {
  if (process.platform === 'win32') {
    const progData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return {
      apiPath: path.join(
        progData,
        'Blackmagic Design',
        'DaVinci Resolve',
        'Support',
        'Developer',
        'Scripting'
      ),
      libPath: path.join(
        process.env.PROGRAMFILES || 'C:\\Program Files',
        'Blackmagic Design',
        'DaVinci Resolve',
        'fusionscript.dll'
      )
    };
  }

  if (process.platform === 'darwin') {
    return {
      apiPath: '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting',
      libPath:
        '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so'
    };
  }

  return {
    apiPath: '/opt/resolve/Developer/Scripting',
    libPath: '/opt/resolve/libs/Fusion/fusionscript.so'
  };
}

export async function detectResolveEnvironment(): Promise<ResolveEnvironment> {
  const { apiPath, libPath } = getResolvePaths();
  const modulesDir = path.join(apiPath, 'Modules');
  const available = await fileExists(modulesDir);
  return {
    available,
    apiPath: available ? modulesDir : null,
    libPath: (await fileExists(libPath)) ? libPath : null
  };
}

export type ResolveAction =
  | 'get_status'
  | 'list_projects'
  | 'create_timeline'
  | 'import_media'
  | 'render_timeline';

export function buildResolvePythonScript(params: {
  modulesDir: string;
  libPath: string | null;
  action: ResolveAction;
  projectName?: string;
  timelineName?: string;
  mediaPaths?: string[];
  presetName?: string;
}): string {
  const payload = JSON.stringify({
    modulesDir: params.modulesDir,
    libPath: params.libPath,
    action: params.action,
    projectName: params.projectName ?? null,
    timelineName: params.timelineName ?? null,
    mediaPaths: params.mediaPaths ?? [],
    presetName: params.presetName ?? null
  });

  return [
    'import json, os, sys',
    `cfg = json.loads(${JSON.stringify(payload)})`,
    'if cfg["modulesDir"] not in sys.path:',
    '    sys.path.append(cfg["modulesDir"])',
    'if cfg["libPath"]:',
    '    os.environ["RESOLVE_SCRIPT_LIB"] = cfg["libPath"]',
    'os.environ["RESOLVE_SCRIPT_API"] = os.path.dirname(cfg["modulesDir"])',
    'import DaVinciResolveScript as dvr',
    'resolve = dvr.scriptapp("Resolve")',
    'if resolve is None:',
    '    raise RuntimeError("DaVinci Resolve is not running or external scripting is disabled in Preferences -> System -> General.")',
    'pm = resolve.GetProjectManager()',
    'if cfg["projectName"]:',
    '    proj = pm.LoadProject(cfg["projectName"]) or pm.CreateProject(cfg["projectName"])',
    'else:',
    '    proj = pm.GetCurrentProject()',
    'action = cfg["action"]',
    'if action == "get_status":',
    '    out = {"version": resolve.GetVersionString(), "currentProject": proj.GetName() if proj else None}',
    'elif action == "list_projects":',
    '    out = {"projects": pm.GetProjectListInCurrentFolder()}',
    'elif action == "create_timeline":',
    '    if not proj: raise RuntimeError("No active Resolve project.")',
    '    mp = proj.GetMediaPool()',
    '    tl = mp.CreateEmptyTimeline(cfg["timelineName"] or "CutRig_Timeline")',
    '    out = {"timeline": tl.GetName() if tl else None}',
    'elif action == "import_media":',
    '    if not proj: raise RuntimeError("No active Resolve project.")',
    '    mp = proj.GetMediaPool()',
    '    items = mp.ImportMedia(cfg["mediaPaths"])',
    '    out = {"importedCount": len(items) if items else 0}',
    'elif action == "render_timeline":',
    '    if not proj: raise RuntimeError("No active Resolve project.")',
    '    if cfg["presetName"]: proj.LoadRenderPreset(cfg["presetName"])',
    '    job_id = proj.AddRenderJob()',
    '    proj.StartRendering(job_id)',
    '    out = {"renderJobId": job_id, "started": True}',
    'else:',
    '    raise ValueError(f"Unsupported Resolve action: {action}")',
    'print(json.dumps(out))'
  ].join('\n');
}

export async function runResolveAction(params: {
  action: ResolveAction;
  projectName?: string;
  timelineName?: string;
  mediaPaths?: string[];
  presetName?: string;
  dryRun?: boolean;
  workspaceRoot?: string;
}) {
  const safeMedia = (params.mediaPaths ?? []).map((p) =>
    resolveSafePath(p, params.workspaceRoot)
  );
  const env = await detectResolveEnvironment();
  const modulesDir = env.apiPath ?? path.join(getResolvePaths().apiPath, 'Modules');

  const script = buildResolvePythonScript({
    modulesDir,
    libPath: env.libPath,
    action: params.action,
    projectName: params.projectName,
    timelineName: params.timelineName,
    mediaPaths: safeMedia,
    presetName: params.presetName
  });

  if (params.dryRun) {
    return {
      dryRun: true,
      resolveInstalled: env.available,
      modulesDir,
      action: params.action,
      scriptPreview: script
    };
  }

  if (!env.available) {
    throw new Error(
      `DaVinci Resolve Scripting Modules not found at ${modulesDir}. Install DaVinci Resolve or use FFmpeg lane.`
    );
  }

  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  const res = await runCommand(pyCmd, ['-I', '-c', script], 60_000);
  if (!res.ok) {
    throw new Error(`DaVinci Resolve action "${params.action}" failed: ${res.stderr || res.stdout}`);
  }

  return {
    dryRun: false,
    action: params.action,
    result: JSON.parse(res.stdout)
  };
}
