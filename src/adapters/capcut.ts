import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { backupIfExists, fileExists, resolveSafePath } from '../utils/safety.js';
import { parseSrt } from './captions.js';
import { probeMedia } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

const US_PER_SEC = 1_000_000;

export interface CapCutDraftSummary {
  name: string;
  path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  tracks: Array<{ type: string; segments: number }>;
}

interface DraftTrack {
  id: string;
  type: 'video' | 'audio' | 'text' | string;
  attribute: number;
  flag: number;
  is_default_name: boolean;
  name: string;
  segments: Array<Record<string, unknown>>;
}

interface DraftContent {
  id: string;
  version: number;
  new_version: string;
  name: string;
  duration: number;
  create_time: number;
  update_time: number;
  fps: number;
  canvas_config: {
    ratio: string;
    width: number;
    height: number;
    background: unknown;
  };
  tracks: DraftTrack[];
  materials: {
    videos: Array<Record<string, unknown>>;
    audios: Array<Record<string, unknown>>;
    texts: Array<Record<string, unknown>>;
    speeds: Array<Record<string, unknown>>;
    canvases: Array<Record<string, unknown>>;
    [key: string]: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
}

function uuidUpper(): string {
  return crypto.randomUUID().toUpperCase();
}

function toUs(sec: number): number {
  return Math.max(0, Math.round(sec * US_PER_SEC));
}

export function getDefaultCapCutDraftsDir(): string | null {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(
      process.env.LOCALAPPDATA,
      'CapCut',
      'User Data',
      'Projects',
      'com.lveditor.draft'
    );
  }
  return null;
}

export async function isCapCutRunning(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq CapCut.exe', '/NH'], {
        windowsHide: true
      });
      return stdout.toLowerCase().includes('capcut.exe');
    } catch {
      return false;
    }
  }
  return false;
}

export async function closeCapCutDesktop(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const running = await isCapCutRunning();
      if (!running) return false;
      await execFileAsync('taskkill', ['/F', '/IM', 'CapCut.exe', '/T'], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function findCapCutExecutable(): Promise<string | null> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const capcutDir = path.join(process.env.LOCALAPPDATA, 'CapCut', 'Apps');
  if (!(await fileExists(capcutDir))) return null;
  try {
    const entries = await readdir(capcutDir, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] ?? 0) - (pa[i] ?? 0);
          if (d !== 0) return d;
        }
        return 0;
      });
    for (const v of versions) {
      const candidate = path.join(capcutDir, v, 'CapCut.exe');
      if (await fileExists(candidate)) return candidate;
    }
  } catch {
    // fallback
  }
  return null;
}

export async function getInstalledCapCutVersion(): Promise<string | null> {
  const exe = await findCapCutExecutable();
  return exe ? path.basename(path.dirname(exe)) : null;
}

export async function openCapCutDesktop(): Promise<boolean> {
  if (process.platform === 'win32') {
    const exe = await findCapCutExecutable();
    if (!exe) return false;
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

interface SiblingDraftProfile {
  platform: Record<string, unknown>;
  last_modified_platform: Record<string, unknown>;
  config: Record<string, unknown>;
  newVersion: string;
}

async function detectSiblingDraftProfile(baseDir: string, excludeDir?: string): Promise<SiblingDraftProfile> {
  const defaultPlatform = {
    os: process.platform === 'win32' ? 'windows' : 'mac',
    os_version: '',
    app_id: 359289,
    app_version: '9.5.0',
    app_source: 'cc',
    device_id: '',
    hard_disk_id: '',
    mac_address: ''
  };
  const defaultConfig = {
    video_mute: false,
    export_range: null,
    maintrack_adsorb: false,
    material_save_mode: 0,
    use_float_render: false,
    hdr_vivid: false
  };

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    let bestMtime = -1;
    let bestProfile: SiblingDraftProfile | null = null;
    const versionVotes = new Map<string, number>();
    const allNewVersions = new Map<string, number>();
    const newVersionByApp = new Map<string, Map<string, number>>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (excludeDir && path.join(baseDir, entry.name).toLowerCase() === excludeDir.toLowerCase()) continue;
      const contentPath = path.join(baseDir, entry.name, 'draft_content.json');
      if (!(await fileExists(contentPath))) continue;
      try {
        const st = await stat(contentPath);
        const raw = await readFile(contentPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const plat = parsed.platform as Record<string, unknown> | undefined;
        const nv = typeof parsed.new_version === 'string' ? parsed.new_version.trim() : '';
        if (nv) allNewVersions.set(nv, (allNewVersions.get(nv) ?? 0) + 1);
        if (plat && typeof plat.app_version === 'string' && plat.app_version.trim()) {
          const av = plat.app_version.trim();
          versionVotes.set(av, (versionVotes.get(av) ?? 0) + 1);
          if (nv) {
            const bucket = newVersionByApp.get(av) ?? new Map<string, number>();
            bucket.set(nv, (bucket.get(nv) ?? 0) + 1);
            newVersionByApp.set(av, bucket);
          }
          if (st.mtimeMs > bestMtime) {
            bestMtime = st.mtimeMs;
            const lastPlat = (parsed.last_modified_platform as Record<string, unknown>) || plat;
            bestProfile = {
              platform: { ...plat },
              last_modified_platform: { ...lastPlat },
              config:
                parsed.config && typeof parsed.config === 'object'
                  ? { ...(parsed.config as Record<string, unknown>), export_range: null }
                  : { ...defaultConfig },
              newVersion: nv
            };
          }
        }
      } catch {
        // Ignore unreadable sibling drafts
      }
    }

    if (bestProfile) {
      // Pick the version most sibling drafts on this machine share — but never above the installed build.
      const installed = await getInstalledCapCutVersion();
      const installedShort = installed ? installed.split('.').slice(0, 2).join('.') : '';
      const rank = (v: string) => {
        const [maj = 0, min = 0, patch = 0] = v.split('.').map((n) => Number(n) || 0);
        return maj * 1_000_000 + min * 1_000 + patch;
      };

      const byVotes = [...versionVotes.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
      const safeApp =
        byVotes.find((v) => !installedShort || rank(v) <= rank(installedShort)) ??
        installedShort ??
        byVotes[0];

      if (safeApp) {
        bestProfile.platform = { ...bestProfile.platform, app_version: safeApp };
        bestProfile.last_modified_platform = { ...bestProfile.last_modified_platform, app_version: safeApp };
      }

      // new_version must match the chosen app_version; otherwise fall back to the most common one.
      const matching = [...(newVersionByApp.get(safeApp ?? '')?.entries() ?? [])].sort(
        (a, b) => b[1] - a[1]
      )[0]?.[0];
      const modeNewVersion = [...allNewVersions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (matching || modeNewVersion) bestProfile.newVersion = matching ?? modeNewVersion!;

      return bestProfile;
    }
  } catch {
    // Ignore store scan errors
  }

  return {
    platform: defaultPlatform,
    last_modified_platform: { ...defaultPlatform },
    config: defaultConfig,
    newVersion: ''
  };
}

export function getDefaultCapCutAudioCacheDir(): string | null {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(
      process.env.LOCALAPPDATA,
      'CapCut',
      'User Data',
      'Cache',
      'music'
    );
  }
  return null;
}

function parseCapCutBeatFile(raw: string): {
  beatsSec: number[];
  downbeatsSec: number[];
} {
  const timeMatch = raw.match(/["']?time["']?\s*:\s*\[([^\]]*)\]/);
  if (!timeMatch) return { beatsSec: [], downbeatsSec: [] };

  const timesMs = timeMatch[1]
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  const valueMatch = raw.match(/["']?value["']?\s*:\s*\[([^\]]*)\]/);
  const values = valueMatch
    ? valueMatch[1]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : [];

  const beatsSec = timesMs.map((ms) => Number((ms / 1000).toFixed(3)));
  const downbeatsSec: number[] = [];
  for (let i = 0; i < beatsSec.length; i++) {
    if (values[i] === 1) downbeatsSec.push(beatsSec[i]);
  }

  return { beatsSec, downbeatsSec };
}

export async function listCapCutCachedAudio(params: {
  cacheDir?: string;
  limit?: number;
  beatPreviewCount?: number;
} = {}) {
  const dir = params.cacheDir
    ? resolveSafePath(params.cacheDir)
    : getDefaultCapCutAudioCacheDir();
  if (!dir || !(await fileExists(dir))) {
    throw new Error('CapCut cached music directory not found. Pass cacheDir explicitly.');
  }

  const audioExts = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
  const entries = await readdir(dir, { withFileTypes: true });
  const audioCandidates: Array<{ name: string; fullPath: string; mtimeMs: number; sizeBytes: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!audioExts.has(ext)) continue;
    const fullPath = path.join(dir, entry.name);
    const st = await stat(fullPath);
    audioCandidates.push({
      name: entry.name,
      fullPath,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size
    });
  }

  audioCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const previewCount = Math.min(200, Math.max(5, params.beatPreviewCount ?? 40));
  const selected = audioCandidates.slice(0, limit);

  const tracks = [];
  for (const item of selected) {
    const stem = path.basename(item.name, path.extname(item.name));
    const beatFile = path.join(dir, `${stem}.beat`);
    const hasBeatFile = await fileExists(beatFile);
    let beatsSec: number[] = [];
    let downbeatsSec: number[] = [];
    if (hasBeatFile) {
      try {
        const beatRaw = await readFile(beatFile, 'utf8');
        const parsed = parseCapCutBeatFile(beatRaw);
        beatsSec = parsed.beatsSec;
        downbeatsSec = parsed.downbeatsSec;
      } catch {
        // Ignore malformed .beat cache files
      }
    }

    let durationSec: number | null = null;
    try {
      const probed = await probeMedia(item.fullPath);
      durationSec = probed.durationSec;
    } catch {
      // Non-fatal if ffprobe unavailable
    }

    tracks.push({
      id: stem,
      fileName: item.name,
      path: item.fullPath,
      sizeBytes: item.sizeBytes,
      modifiedAt: new Date(item.mtimeMs).toISOString(),
      durationSec,
      hasBeatFile,
      beatCount: beatsSec.length,
      downbeatsSec: downbeatsSec.slice(0, previewCount),
      beatsSecPreview: beatsSec.slice(0, previewCount)
    });
  }

  return {
    cacheDir: dir,
    totalAudioFiles: audioCandidates.length,
    returnedCount: tracks.length,
    tracks
  };
}

export async function listCapCutDrafts(customDir?: string): Promise<{
  draftsDir: string;
  drafts: CapCutDraftSummary[];
}> {
  const dir = customDir ? resolveSafePath(customDir) : getDefaultCapCutDraftsDir();
  if (!dir || !(await fileExists(dir))) {
    throw new Error('CapCut drafts directory not found. Provide draftsDir explicitly.');
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const drafts: CapCutDraftSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const draftPath = path.join(dir, entry.name);
    const contentFile = path.join(draftPath, 'draft_content.json');
    if (!(await fileExists(contentFile))) continue;

    try {
      const raw = await readFile(contentFile, 'utf8');
      const data = JSON.parse(raw) as Partial<DraftContent>;
      drafts.push({
        name: data.name || entry.name,
        path: draftPath,
        durationSec: Number(((data.duration ?? 0) / US_PER_SEC).toFixed(3)),
        width: data.canvas_config?.width ?? 0,
        height: data.canvas_config?.height ?? 0,
        fps: data.fps ?? 30,
        tracks: (data.tracks ?? []).map((t) => ({
          type: t.type,
          segments: Array.isArray(t.segments) ? t.segments.length : 0
        }))
      });
    } catch {
      // Skip unreadable/encrypted drafts cleanly
    }
  }

  return { draftsDir: dir, drafts };
}

export async function createCapCutDraft(params: {
  name: string;
  draftsDir?: string;
  width?: number;
  height?: number;
  fps?: number;
  overwrite?: boolean;
}) {
  const baseDir = params.draftsDir
    ? resolveSafePath(params.draftsDir)
    : getDefaultCapCutDraftsDir();
  if (!baseDir) {
    throw new Error('CapCut drafts directory not available on this OS. Pass draftsDir explicitly.');
  }

  const safeName = params.name.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!safeName) throw new Error('Draft name cannot be empty.');

  const draftPath = resolveSafePath(safeName, baseDir);
  const contentFile = path.join(draftPath, 'draft_content.json');
  const metaFile = path.join(draftPath, 'draft_meta_info.json');

  const backups: string[] = [];
  if (await fileExists(contentFile)) {
    if (!params.overwrite) {
      throw new Error(`CapCut draft already exists: ${draftPath}. Pass overwrite: true to replace with .bak backup.`);
    }
    const b1 = await backupIfExists(contentFile);
    const b2 = await backupIfExists(metaFile);
    if (b1) backups.push(b1);
    if (b2) backups.push(b2);
  }

  await mkdir(draftPath, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const nowUs = Date.now() * 1000;
  const draftId = uuidUpper();
  const width = params.width ?? 1920;
  const height = params.height ?? 1080;
  const fps = params.fps ?? 30;
  const profile = await detectSiblingDraftProfile(baseDir);

  const content: DraftContent = {
    id: draftId,
    version: 360000,
    new_version: '187.0.0',
    name: safeName,
    duration: 0,
    create_time: nowSec,
    update_time: nowSec,
    fps,
    is_drop_frame_timecode: false,
    color_space: 0,
    config: profile.config,
    canvas_config: {
      ratio: `${width}:${height}`,
      width,
      height,
      background: null
    },
    tracks: [
      { id: uuidUpper(), type: 'video', attribute: 0, flag: 0, is_default_name: true, name: '', segments: [] },
      { id: uuidUpper(), type: 'audio', attribute: 0, flag: 0, is_default_name: true, name: '', segments: [] },
      { id: uuidUpper(), type: 'text', attribute: 0, flag: 0, is_default_name: true, name: '', segments: [] }
    ],
    materials: {
      videos: [],
      audios: [],
      texts: [],
      speeds: [],
      canvases: []
    },
    keyframes: {
      adjusts: [],
      audios: [],
      effects: [],
      filters: [],
      handwrites: [],
      stickers: [],
      texts: [],
      videos: []
    },
    keyframe_graph_list: [],
    platform: profile.platform,
    last_modified_platform: profile.last_modified_platform,
    extra_info: {},
    relationships: [],
    mixed_track_mode_on: false,
    render_index_track_mode_on: true,
    free_render_index_mode_on: false,
    static_cover_image_path: '',
    source: 'default',
    time_marks: null,
    path: '',
    lyrics_effects: [],
    draft_type: 'video'
  };

  const meta = {
    draft_id: draftId,
    draft_name: safeName,
    draft_fold_path: draftPath.replace(/\\/g, '/'),
    draft_root_path: baseDir.replace(/\\/g, '/'),
    draft_new_version: '',
    draft_removable_storage_device: '',
    draft_materials: [
      { type: 0, value: [] },
      { type: 1, value: [] },
      { type: 2, value: [] }
    ],
    draft_materials_copied_info: [],
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_duration: 0
  };

  const settingsBody = [
    '[General]',
    `draft_create_time=${nowSec}`,
    `draft_last_edit_time=${nowSec}`,
    'real_edit_seconds=0',
    'real_edit_keys=1',
    `cloud_last_modify_platform=${process.platform === 'win32' ? 'windows' : 'mac'}`
  ].join('\n') + '\n';

  await Promise.all([
    writeFile(contentFile, JSON.stringify(content, null, 2), 'utf8'),
    writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8'),
    writeFile(path.join(draftPath, 'draft_settings'), settingsBody, 'utf8')
  ]);

  await syncRootMetaInfo(baseDir, {
    draftId,
    draftName: safeName,
    draftPath,
    contentFile,
    durationUs: 0,
    nowUs
  });

  return { draftId, name: safeName, draftPath, width, height, fps, backups };
}

async function syncRootMetaInfo(
  baseDir: string,
  entry: {
    draftId: string;
    draftName: string;
    draftPath: string;
    contentFile: string;
    durationUs: number;
    nowUs: number;
  }
): Promise<void> {
  const rootMetaPath = path.join(baseDir, 'root_meta_info.json');
  if (!(await fileExists(rootMetaPath))) return;

  try {
    const raw = await readFile(rootMetaPath, 'utf8');
    const rootMeta = JSON.parse(raw) as {
      all_draft_store?: Array<Record<string, unknown>>;
      draft_ids?: number;
      root_path?: string;
    };
    if (!Array.isArray(rootMeta.all_draft_store)) return;

    await backupIfExists(rootMetaPath);

    const foldSlash = entry.draftPath.replace(/\\/g, '/');
    const rootSlash = baseDir.replace(/\\/g, '/');
    const jsonFile = path.join(entry.draftPath, 'draft_content.json').replace(/\\/g, '/');
    const existingIdx = rootMeta.all_draft_store.findIndex(
      (item) =>
        item.draft_id === entry.draftId ||
        String(item.draft_fold_path || '').toLowerCase() === foldSlash.toLowerCase()
    );

    const templateRecord =
      existingIdx >= 0
        ? rootMeta.all_draft_store[existingIdx]
        : rootMeta.all_draft_store[0] ?? {};

    const record = {
      ...templateRecord,
      cloud_draft_cover: false,
      cloud_draft_sync: false,
      draft_cover: `${foldSlash}/draft_cover.jpg`,
      draft_fold_path: foldSlash,
      draft_id: entry.draftId,
      draft_is_invisible: false,
      draft_json_file: `${foldSlash}/draft_content.json`,
      draft_name: entry.draftName,
      draft_new_version: '',
      draft_root_path: rootSlash,
      tm_draft_create:
        existingIdx >= 0
          ? rootMeta.all_draft_store[existingIdx].tm_draft_create ?? entry.nowUs
          : entry.nowUs,
      tm_draft_modified: entry.nowUs,
      tm_draft_removed: 0,
      tm_duration: entry.durationUs
    };

    if (existingIdx >= 0) {
      rootMeta.all_draft_store[existingIdx] = record;
    } else {
      rootMeta.all_draft_store.unshift(record);
      rootMeta.draft_ids = (rootMeta.draft_ids ?? rootMeta.all_draft_store.length) + 1;
    }

    await writeFile(rootMetaPath, JSON.stringify(rootMeta), 'utf8');
  } catch {
    // Non-fatal if user's CapCut root_meta_info.json has a custom schema
  }
}

async function loadDraft(draftPath: string): Promise<{
  dir: string;
  contentFile: string;
  metaFile: string;
  content: DraftContent;
  meta: Record<string, unknown> | null;
}> {
  const dir = resolveSafePath(draftPath);
  const contentFile = path.join(dir, 'draft_content.json');
  const metaFile = path.join(dir, 'draft_meta_info.json');

  const raw = await readFile(contentFile, 'utf8');
  const content = JSON.parse(raw) as DraftContent;
  content.tracks ??= [];
  content.materials ??= { videos: [], audios: [], texts: [], speeds: [], canvases: [] };
  content.materials.videos ??= [];
  content.materials.audios ??= [];
  content.materials.texts ??= [];
  content.materials.speeds ??= [];
  content.materials.canvases ??= [];

  let meta: Record<string, unknown> | null = null;
  if (await fileExists(metaFile)) {
    meta = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
  }

  return { dir, contentFile, metaFile, content, meta };
}

function recomputeDurationUs(content: DraftContent): number {
  let maxEnd = 0;
  for (const track of content.tracks) {
    for (const seg of track.segments ?? []) {
      const tr = seg.target_timerange as { start?: number; duration?: number } | undefined;
      if (tr) {
        maxEnd = Math.max(maxEnd, (tr.start ?? 0) + (tr.duration ?? 0));
      }
    }
  }
  content.duration = maxEnd;
  content.update_time = Math.floor(Date.now() / 1000);
  return maxEnd;
}

async function persistDraftMutation(params: {
  draftPath: string;
  contentFile: string;
  metaFile: string;
  content: DraftContent;
  meta: Record<string, unknown> | null;
  /** Set false when the caller already closed CapCut (adjustCapCutTiming does). */
  manageCapCut?: boolean;
}): Promise<number> {
  const safeDraftDir = resolveSafePath(params.draftPath);
  // CapCut holds the open timeline in RAM and re-saves over disk, silently discarding external edits.
  // Every mutation goes through this function, so the process is terminated here once, not per tool.
  let closedHere = false;
  if (params.manageCapCut !== false) {
    closedHere = await closeCapCutDesktop();
    if (closedHere) await new Promise((r) => setTimeout(r, 400));
  }
  const baseDir = path.dirname(safeDraftDir);
  const totalUs = recomputeDurationUs(params.content);
  const nowUs = Date.now() * 1000;
  params.content.update_time = Math.floor(nowUs / US_PER_SEC);

  const plat = params.content.platform as Record<string, unknown> | undefined;
  if (!plat || !String(plat.app_version || '').trim()) {
    const profile = await detectSiblingDraftProfile(baseDir);
    params.content.platform = profile.platform;
    params.content.last_modified_platform = profile.last_modified_platform;
    if (!params.content.config || typeof params.content.config !== 'object') {
      params.content.config = profile.config;
    }
    params.content.render_index_track_mode_on ??= true;
    params.content.free_render_index_mode_on ??= false;
    params.content.mixed_track_mode_on ??= false;
    params.content.draft_type ??= 'video';
    params.content.source ??= 'default';
  }

  // Version guard: "requires the latest app version" fires when the draft claims an app build NEWER than
  // the one installed, OR when platform and last_modified_platform disagree. Pin BOTH to the installed
  // build — consistent by construction, and never newer than what is actually on disk.
  // Keep all three parts ("9.6.0"): CapCut writes 3 parts, and a 2-part "9.6" reads as a different build.
  const installed = await getInstalledCapCutVersion();
  const installedShort = installed ? installed.split('.').slice(0, 3).join('.') : '';
  if (installedShort) {
    for (const key of ['platform', 'last_modified_platform'] as const) {
      const block = (params.content[key] as Record<string, unknown> | undefined) ?? {};
      params.content[key] = { ...block, app_version: installedShort };
    }
    // ponytail: new_version (187/189/...) has no documented -> app build mapping, so it is left alone.
    // Add a ceiling table here only if a real draft is ever rejected for format, not app, version.
  }

  const contentJson = JSON.stringify(params.content, null, 2);
  const writes: Array<Promise<void>> = [writeFile(params.contentFile, contentJson, 'utf8')];
  const timelineContentFile = path.join(safeDraftDir, 'Timelines', params.content.id, 'draft_content.json');
  if (await fileExists(timelineContentFile)) {
    writes.push(writeFile(timelineContentFile, contentJson, 'utf8'));
  }

  if (params.meta) {
    params.meta.tm_duration = totalUs;
    params.meta.tm_draft_modified = nowUs;
    params.meta.draft_root_path = baseDir.replace(/\\/g, '/');
    params.meta.draft_fold_path = safeDraftDir.replace(/\\/g, '/');
    params.meta.draft_new_version = '';

    const dm = (params.meta.draft_materials as Array<{ type: number; value: Array<Record<string, unknown>> }>) ?? [];
    let group0 = dm.find((g) => g.type === 0);
    if (!group0) {
      group0 = { type: 0, value: [] };
      dm.push(group0);
      params.meta.draft_materials = dm;
    }
    const existingPaths = new Set(group0.value.map((m) => String(m.file_Path || '').toLowerCase()));
    const secNow = Math.floor(nowUs / US_PER_SEC);

    for (const v of params.content.materials.videos) {
      const p = String(v.path || '');
      if (p && !p.includes('##_draftpath_placeholder_') && !existingPaths.has(p.toLowerCase())) {
        existingPaths.add(p.toLowerCase());
        group0.value.push({
          ai_group_type: '',
          create_time: secNow,
          duration: v.duration ?? 0,
          enter_from: 0,
          extra_info: v.material_name ?? path.basename(p),
          file_Path: p,
          height: v.height ?? 0,
          id: uuidUpper().toLowerCase(),
          import_time: secNow,
          import_time_ms: Date.now(),
          item_source: 1,
          material_color_tag: '',
          md5: '',
          metetype: 'video',
          roughcut_time_range: { duration: -1, start: -1 },
          sub_time_range: { duration: -1, start: -1 },
          type: 0,
          width: v.width ?? 0
        });
      }
    }

    for (const a of params.content.materials.audios) {
      const p = String(a.path || '');
      if (p && !p.includes('##_draftpath_placeholder_') && !existingPaths.has(p.toLowerCase())) {
        existingPaths.add(p.toLowerCase());
        group0.value.push({
          ai_group_type: '',
          create_time: secNow,
          duration: a.duration ?? 0,
          enter_from: 0,
          extra_info: a.name ?? path.basename(p),
          file_Path: p,
          height: 0,
          id: uuidUpper().toLowerCase(),
          import_time: secNow,
          import_time_ms: Date.now(),
          item_source: 1,
          material_color_tag: '',
          md5: '',
          metetype: 'music',
          roughcut_time_range: { duration: -1, start: -1 },
          sub_time_range: { duration: -1, start: -1 },
          type: 0,
          width: 0
        });
      }
    }

    writes.push(writeFile(params.metaFile, JSON.stringify(params.meta, null, 2), 'utf8'));
  }

  await Promise.all(writes);

  const metaDraftId = typeof params.meta?.draft_id === 'string' && params.meta.draft_id
    ? params.meta.draft_id
    : params.content.id;
  const metaDraftName = typeof params.meta?.draft_name === 'string' && params.meta.draft_name
    ? params.meta.draft_name
    : params.content.name || path.basename(safeDraftDir);

  await syncRootMetaInfo(baseDir, {
    draftId: metaDraftId,
    draftName: metaDraftName,
    draftPath: safeDraftDir,
    contentFile: params.contentFile,
    durationUs: totalUs,
    nowUs
  });

  if (closedHere) await openCapCutDesktop();
  return totalUs;
}

export async function insertClipsToCapCutDraft(params: {
  draftPath: string;
  clips: Array<{
    path: string;
    trackType?: 'video' | 'audio';
    startSec?: number;
    trimStartSec?: number;
    durationSec?: number;
    volume?: number;
    /** Audio only: fade-in / fade-out length in seconds (CapCut audio_fades material). */
    fadeInSec?: number;
    fadeOutSec?: number;
  }>;
}) {
  if (params.clips.length === 0) throw new Error('Provide at least one clip to insert.');

  const { contentFile, metaFile, content, meta } = await loadDraft(params.draftPath);
  const backupContent = await backupIfExists(contentFile);
  const backupMeta = await backupIfExists(metaFile);

  const inserted: Array<{ path: string; trackType: string; startSec: number; durationSec: number }> = [];

  for (const clip of params.clips) {
    const resolvedClip = resolveSafePath(clip.path);
    const probed = await probeMedia(resolvedClip);
    const clipStats = await stat(resolvedClip);

    const trackType = clip.trackType ?? (probed.video ? 'video' : 'audio');
    if (trackType === 'video' && !probed.video) {
      throw new Error(`Clip has no video stream: ${resolvedClip}`);
    }
    if (trackType === 'audio' && !probed.audio) {
      throw new Error(`Clip has no audio stream: ${resolvedClip}`);
    }

    let track = content.tracks.find((t) => t.type === trackType);
    if (!track) {
      track = {
        id: uuidUpper(),
        type: trackType,
        attribute: 0,
        flag: 0,
        is_default_name: true,
        name: '',
        segments: []
      };
      content.tracks.push(track);
    }

    const trackTailUs = track.segments.reduce((acc, seg) => {
      const tr = seg.target_timerange as { start?: number; duration?: number } | undefined;
      return Math.max(acc, (tr?.start ?? 0) + (tr?.duration ?? 0));
    }, 0);

    const trimStartSec = clip.trimStartSec ?? 0;
    const totalDurSec = probed.durationSec || 5;
    const durationSec = clip.durationSec ?? Math.max(0.1, totalDurSec - trimStartSec);
    const startUs = clip.startSec !== undefined ? toUs(clip.startSec) : trackTailUs;
    const durUs = toUs(durationSec);

    const materialId = uuidUpper();
    const speedId = uuidUpper();

    content.materials.speeds.push({
      id: speedId,
      curve_speed: null,
      mode: 0,
      speed: 1,
      type: 'speed'
    });

    if (trackType === 'video') {
      const canvasId = uuidUpper();
      content.materials.canvases.push({
        id: canvasId,
        type: 'canvas_color',
        color: '',
        image: '',
        album_image: '',
        blur: 0
      });

      content.materials.videos.push({
        id: materialId,
        type: 'video',
        path: resolvedClip.replace(/\\/g, '/'),
        material_name: path.basename(resolvedClip),
        category_name: 'local',
        duration: toUs(totalDurSec),
        width: probed.video!.width,
        height: probed.video!.height,
        has_audio: probed.audio !== null,
        crop_ratio: 'free',
        crop: {
          upper_left_x: 0,
          upper_left_y: 0,
          upper_right_x: 1,
          upper_right_y: 0,
          lower_left_x: 0,
          lower_left_y: 1,
          lower_right_x: 1,
          lower_right_y: 1
        },
        source_platform: 0
      });

      track.segments.push({
        id: uuidUpper(),
        material_id: materialId,
        source_timerange: { start: toUs(trimStartSec), duration: durUs },
        target_timerange: { start: startUs, duration: durUs },
        render_timerange: { start: 0, duration: 0 },
        speed: 1,
        volume: clip.volume ?? 1,
        clip: {
          scale: { x: 1, y: 1 },
          rotation: 0,
          transform: { x: 0, y: 0 },
          flip: { vertical: false, horizontal: false },
          alpha: 1
        },
        uniform_scale: { on: true, value: 1 },
        extra_material_refs: [speedId, canvasId]
      });
    } else {
      content.materials.audios.push({
        id: materialId,
        type: 'extract_music',
        path: resolvedClip.replace(/\\/g, '/'),
        name: path.basename(resolvedClip),
        category_name: 'local',
        duration: toUs(totalDurSec),
        size: clipStats.size
      });

      // Audio fade in/out: CapCut reads these from a companion audio_fade material, not the segment.
      const fadeRefs: string[] = [];
      const fadeInUs = toUs(Math.min(clip.fadeInSec ?? 0, durationSec));
      const fadeOutUs = toUs(Math.min(clip.fadeOutSec ?? 0, durationSec));
      if (fadeInUs > 0 || fadeOutUs > 0) {
        const fadeId = uuidUpper();
        content.materials.audio_fades ??= [];
        content.materials.audio_fades.push({
          id: fadeId,
          type: 'audio_fade',
          fade_type: 0,
          fade_in_duration: fadeInUs,
          fade_out_duration: fadeOutUs
        });
        fadeRefs.push(fadeId);
      }

      track.segments.push({
        id: uuidUpper(),
        material_id: materialId,
        source_timerange: { start: toUs(trimStartSec), duration: durUs },
        target_timerange: { start: startUs, duration: durUs },
        speed: 1,
        volume: clip.volume ?? 1,
        extra_material_refs: [speedId, ...fadeRefs]
      });
    }

    inserted.push({
      path: resolvedClip,
      trackType,
      startSec: Number((startUs / US_PER_SEC).toFixed(3)),
      durationSec
    });
  }

  const totalUs = await persistDraftMutation({
    draftPath: params.draftPath,
    contentFile,
    metaFile,
    content,
    meta
  });

  return {
    draftPath: resolveSafePath(params.draftPath),
    insertedCount: inserted.length,
    inserted,
    totalDurationSec: Number((totalUs / US_PER_SEC).toFixed(3)),
    backups: [backupContent, backupMeta].filter(Boolean)
  };
}

export async function addTextToCapCutDraft(params: {
  draftPath: string;
  /** Import every subtitle cue from an .srt/.ass-free SRT file (pyJianYingDraft template replacement). */
  srtPath?: string;
  items?: Array<{
    text: string;
    startSec: number;
    durationSec: number;
    fontSize?: number;
    colorRgb?: number[];
    yOffset?: number;
  }>;
}) {
  const items = [...(params.items ?? [])];
  if (params.srtPath) {
    const srtRaw = await readFile(resolveSafePath(params.srtPath), 'utf8');
    for (const cue of parseSrt(srtRaw)) {
      items.push({
        text: cue.text,
        startSec: cue.startSec,
        durationSec: Math.max(0.2, cue.endSec - cue.startSec)
      });
    }
  }
  if (items.length === 0) throw new Error('Provide items or srtPath with at least one cue.');

  const { contentFile, metaFile, content, meta } = await loadDraft(params.draftPath);
  const backupContent = await backupIfExists(contentFile);
  const backupMeta = await backupIfExists(metaFile);

  let textTrack = content.tracks.find((t) => t.type === 'text');
  if (!textTrack) {
    textTrack = {
      id: uuidUpper(),
      type: 'text',
      attribute: 0,
      flag: 0,
      is_default_name: true,
      name: '',
      segments: []
    };
    content.tracks.push(textTrack);
  }

  for (const item of items) {
    const materialId = uuidUpper();
    const color = item.colorRgb ?? [1, 1, 1];
    const size = item.fontSize ?? 7;

    content.materials.texts.push({
      id: materialId,
      type: 'text',
      content: JSON.stringify({
        text: item.text,
        styles: [
          {
            fill: {
              content: {
                render_type: 'solid',
                solid: { color }
              }
            },
            size,
            range: [0, item.text.length]
          }
        ]
      }),
      global_alpha: 1,
      alignment: 1
    });

    textTrack.segments.push({
      id: uuidUpper(),
      material_id: materialId,
      target_timerange: {
        start: toUs(item.startSec),
        duration: toUs(item.durationSec)
      },
      clip: {
        scale: { x: 1, y: 1 },
        rotation: 0,
        transform: { x: 0, y: item.yOffset ?? -0.75 },
        flip: { vertical: false, horizontal: false },
        alpha: 1
      },
      uniform_scale: { on: true, value: 1 },
      extra_material_refs: []
    });
  }

  const totalUs = await persistDraftMutation({
    draftPath: params.draftPath,
    contentFile,
    metaFile,
    content,
    meta
  });

  return {
    draftPath: resolveSafePath(params.draftPath),
    addedCount: items.length,
    totalDurationSec: Number((totalUs / US_PER_SEC).toFixed(3)),
    backups: [backupContent, backupMeta].filter(Boolean)
  };
}

export async function resolveCapCutDraftPath(params: {
  draftPath?: string;
  draftName?: string;
  draftsDir?: string;
}): Promise<string> {
  if (params.draftPath) return resolveSafePath(params.draftPath);
  if (!params.draftName) {
    throw new Error('Provide either draftPath or draftName.');
  }
  const baseDir = params.draftsDir
    ? resolveSafePath(params.draftsDir)
    : getDefaultCapCutDraftsDir();
  if (!baseDir) {
    throw new Error('CapCut drafts directory not available on this OS. Pass draftPath or draftsDir explicitly.');
  }
  return resolveSafePath(params.draftName, baseDir);
}

/**
 * Undo: restore draft_content.json / draft_meta_info.json from the newest .bak snapshot.
 * Every mutation writes one, so this is the safety net when a batch of edits goes wrong.
 */
export async function restoreCapCutBackup(params: {
  draftPath?: string;
  draftName?: string;
  draftsDir?: string;
  /** Restore a specific snapshot instead of the newest one (path as returned by listBackups). */
  backupPath?: string;
}) {
  const targetDir = await resolveCapCutDraftPath(params);
  const listBackups = async (file: string) => {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries
      .filter((e) => e.startsWith(`${base}.`) && e.endsWith('.bak'))
      .map((e) => path.join(dir, e))
      .sort()
      .reverse();
  };

  const contentFile = path.join(targetDir, 'draft_content.json');
  const metaFile = path.join(targetDir, 'draft_meta_info.json');

  let restoreContent: string | null = null;
  let restoreMeta: string | null = null;

  if (params.backupPath) {
    const explicit = resolveSafePath(params.backupPath);
    if (!(await fileExists(explicit))) throw new Error(`Backup not found: ${explicit}`);
    if (path.basename(explicit).startsWith('draft_content.json')) restoreContent = explicit;
    else if (path.basename(explicit).startsWith('draft_meta_info.json')) restoreMeta = explicit;
    else throw new Error('backupPath must point at a draft_content.json.*.bak or draft_meta_info.json.*.bak file.');
  } else {
    restoreContent = (await listBackups(contentFile))[0] ?? null;
    restoreMeta = (await listBackups(metaFile))[0] ?? null;
  }

  if (!restoreContent && !restoreMeta) {
    throw new Error(`No .bak snapshots found in ${targetDir}`);
  }

  // Snapshot the current (possibly broken) state first so the restore itself is reversible.
  const safetyContent = await backupIfExists(contentFile);
  const safetyMeta = await backupIfExists(metaFile);

  const closed = await closeCapCutDesktop();
  if (closed) await new Promise((r) => setTimeout(r, 400));

  if (restoreContent) await copyFile(restoreContent, contentFile);
  if (restoreMeta) await copyFile(restoreMeta, metaFile);

  // Keep the mirrored timeline copy in sync, or CapCut reads the stale one.
  try {
    const restored = JSON.parse(await readFile(contentFile, 'utf8')) as DraftContent;
    const timelineFile = path.join(targetDir, 'Timelines', restored.id, 'draft_content.json');
    if (await fileExists(timelineFile)) {
      await copyFile(contentFile, timelineFile);
    }
  } catch {
    // Timeline mirror is best-effort; the main draft file is already restored.
  }

  if (closed) await openCapCutDesktop();

  return {
    draftPath: targetDir,
    restoredContent: restoreContent,
    restoredMeta: restoreMeta,
    undoSnapshot: [safetyContent, safetyMeta].filter(Boolean),
    capcutClosed: closed
  };
}

export function getDefaultCapCutEffectCacheDir(): string | null {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'CapCut', 'User Data', 'Cache', 'effect');
  }
  return null;
}

const DEFAULT_ADJUST_BUNDLE_ID = '7501974767453474064';

async function resolveAdjustBundle(effectCacheDir?: string): Promise<{
  bundleId: string;
  bundlePath: string;
  lumiHubPath: string;
}> {
  const cacheRoot = effectCacheDir
    ? resolveSafePath(effectCacheDir)
    : getDefaultCapCutEffectCacheDir();
  if (cacheRoot) {
    const bundleDir = path.join(cacheRoot, DEFAULT_ADJUST_BUNDLE_ID);
    if (await fileExists(bundleDir)) {
      try {
        const subdirs = await readdir(bundleDir, { withFileTypes: true });
        const candidates = subdirs
          .filter((d) => d.isDirectory() && !d.name.endsWith('_tmp'))
          .map((d) => d.name)
          .sort();
        for (const sub of candidates) {
          const full = path.join(bundleDir, sub).replace(/\\/g, '/');
          const lumi = `${full}/lumi_hub_path`;
          if (await fileExists(lumi)) {
            return { bundleId: DEFAULT_ADJUST_BUNDLE_ID, bundlePath: full, lumiHubPath: lumi };
          }
        }
        if (candidates.length > 0) {
          const full = path.join(bundleDir, candidates[0]).replace(/\\/g, '/');
          return {
            bundleId: DEFAULT_ADJUST_BUNDLE_ID,
            bundlePath: full,
            lumiHubPath: `${full}/lumi_hub_path`
          };
        }
      } catch {
        // Fallback below
      }
    }
  }
  return { bundleId: DEFAULT_ADJUST_BUNDLE_ID, bundlePath: '', lumiHubPath: '' };
}

/**
 * Read-only health check: catches every failure mode that makes CapCut show an empty timeline or a
 * "requires the latest app version" dialog, without opening CapCut. Run it before/after a mutation.
 */
export async function validateCapCutDraft(params: {
  draftPath?: string;
  draftName?: string;
  draftsDir?: string;
  textMinGapAfterTransitionSec?: number;
}) {
  const targetDir = await resolveCapCutDraftPath(params);
  const { content } = await loadDraft(targetDir);
  const issues: Array<{ severity: 'error' | 'warning'; code: string; detail: string }> = [];

  const mats = content.materials as Record<string, Array<Record<string, unknown>>>;
  const materialIds = new Set<string>();
  for (const key of Object.keys(mats)) {
    for (const m of mats[key] ?? []) {
      if (m && typeof m === 'object' && m.id) materialIds.add(String(m.id));
    }
  }

  // 1. Dangling references — CapCut silently drops the segment (or the whole track) when this happens.
  let danglingRefs = 0;
  let missingMaterials = 0;
  for (const track of content.tracks) {
    for (const seg of track.segments ?? []) {
      if (seg.material_id && !materialIds.has(String(seg.material_id))) missingMaterials++;
      for (const ref of (seg.extra_material_refs as unknown[] | undefined) ?? []) {
        if (!materialIds.has(String(ref))) danglingRefs++;
      }
    }
  }
  if (missingMaterials > 0) {
    issues.push({
      severity: 'error',
      code: 'missing_material',
      detail: `${missingMaterials} segment(s) point at a material_id that does not exist`
    });
  }
  if (danglingRefs > 0) {
    issues.push({
      severity: 'error',
      code: 'dangling_ref',
      detail: `${danglingRefs} extra_material_refs entry(ies) point at missing materials`
    });
  }

  // 2. Version pair — the dialog's actual trigger is new_version demanding a newer build than
  // platform.app_version claims, or the two platform blocks disagreeing with each other.
  const installed = await getInstalledCapCutVersion();
  const installedShort = installed ? installed.split('.').slice(0, 3).join('.') : '';
  const platApp = String((content.platform as Record<string, unknown> | undefined)?.app_version ?? '').trim();
  const lmpApp = String(
    (content.last_modified_platform as Record<string, unknown> | undefined)?.app_version ?? ''
  ).trim();
  const newVersion = String(content.new_version ?? '').trim();
  if (!platApp || !lmpApp) {
    issues.push({ severity: 'error', code: 'missing_app_version', detail: 'platform.app_version is empty' });
  } else if (platApp !== lmpApp) {
    // This exact inconsistency is what re-triggers the dialog, so it is an error, not a warning.
    issues.push({
      severity: 'error',
      code: 'app_version_mismatch',
      detail: `platform.app_version ${platApp} != last_modified_platform.app_version ${lmpApp}`
    });
  }
  const majorNewVersion = Number(newVersion.split('.')[0] || 0);
  if (installedShort && majorNewVersion > 0) {
    // 187.x needs 9.5, 189.x needs 9.6 — a draft demanding more than the install can open shows the dialog.
    const requiredMinor = majorNewVersion >= 189 ? 6 : majorNewVersion >= 187 ? 5 : 0;
    const installedMinor = Number(installedShort.split('.')[1] ?? 0);
    if (requiredMinor && installedMinor < requiredMinor) {
      issues.push({
        severity: 'error',
        code: 'draft_needs_newer_app',
        detail: `draft new_version ${newVersion} needs CapCut 9.${requiredMinor}+, installed is ${installedShort}`
      });
    }
  }

  // 3. Text clipped past the canvas — the original 112.png/113.png defect.
  const canvasWidth = Number(content.canvas_config?.width ?? 1920) || 1920;
  let oversized = 0;
  let textIndex = 0;
  for (const track of content.tracks) {
    if (track.type !== 'text') continue;
    for (const seg of track.segments ?? []) {
      const clip = seg.clip as { scale?: { x?: number; y?: number } } | undefined;
      if ((clip?.scale?.x ?? 1) > 0.8 || (clip?.scale?.y ?? 1) > 0.8) oversized++;
      textIndex++;
    }
  }
  if (oversized > 0) {
    issues.push({
      severity: 'warning',
      code: 'text_scale_above_safe',
      detail: `${oversized} text clip(s) use scale > 0.8 and may overflow a ${canvasWidth}px canvas`
    });
  }

  // 4. Text starting inside a transition window — pops in mid-blend.
  const gapUs = toUs(params.textMinGapAfterTransitionSec ?? 0.2);
  const transitions = mats.transitions ?? [];
  const windows: Array<{ startUs: number; endUs: number }> = [];
  for (const track of content.tracks) {
    if (track.type !== 'video') continue;
    const segs = track.segments ?? [];
    for (let i = 0; i < segs.length; i++) {
      const refs = Array.isArray(segs[i].extra_material_refs)
        ? (segs[i].extra_material_refs as unknown[]).map(String)
        : [];
      const transMat = transitions.find((t) => refs.includes(String(t.id)));
      if (!transMat) continue;
      const durUs = Number(transMat.duration ?? toUs(0.5));
      const tr = segs[i].target_timerange as { start?: number; duration?: number } | undefined;
      const cutUs = (tr?.start ?? 0) + (tr?.duration ?? 0);
      if (i < segs.length - 1) {
        const half = Math.round(durUs / 2);
        windows.push({ startUs: Math.max(0, cutUs - half), endUs: cutUs + half });
      }
    }
  }
  const badTextStarts: Array<{ index: number; startSec: number }> = [];
  textIndex = 0;
  for (const track of content.tracks) {
    if (track.type !== 'text') continue;
    for (const seg of track.segments ?? []) {
      const tr = seg.target_timerange as { start?: number } | undefined;
      const startUs = tr?.start ?? 0;
      if (windows.some((w) => startUs >= w.startUs && startUs < w.endUs + gapUs)) {
        badTextStarts.push({ index: textIndex, startSec: Number((startUs / US_PER_SEC).toFixed(3)) });
      }
      textIndex++;
    }
  }
  if (badTextStarts.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'text_starts_in_transition',
      detail: `${badTextStarts.length} text clip(s) start inside a transition: ${badTextStarts
        .map((b) => `#${b.index}@${b.startSec}s`)
        .join(', ')}`
    });
  }

  // 5. Zero-duration or empty tracks — CapCut opens these as a blank project.
  const emptyTracks = content.tracks.filter((t) => (t.segments ?? []).length === 0).length;
  if (emptyTracks > 0) {
    issues.push({
      severity: 'warning',
      code: 'empty_track',
      detail: `${emptyTracks} track(s) have no segments`
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return {
    draftName: String(content.name || path.basename(targetDir)),
    draftPath: targetDir,
    ok: errorCount === 0,
    errorCount,
    warningCount: issues.length - errorCount,
    issues,
    version: { newVersion, platformApp: platApp, lastModifiedApp: lmpApp, installed: installedShort || null },
    canvas: `${canvasWidth}x${content.canvas_config?.height ?? 1080}`,
    durationSec: Number(((content.duration ?? 0) / US_PER_SEC).toFixed(3)),
    counts: {
      tracks: content.tracks.length,
      segments: content.tracks.reduce((n, t) => n + (t.segments ?? []).length, 0),
      texts: (mats.texts ?? []).length
    }
  };
}

export async function inspectCapCutDraft(params: {
  draftPath?: string;
  draftName?: string;
  draftsDir?: string;
}) {  const targetDir = await resolveCapCutDraftPath(params);
  const { content, meta } = await loadDraft(targetDir);

  const effects = ((content.materials as Record<string, unknown>).effects as Array<Record<string, unknown>> | undefined) ?? [];
  const placeholders = ((content.materials as Record<string, unknown>).placeholders as Array<Record<string, unknown>> | undefined) ?? [];
  const colorCurves = ((content.materials as Record<string, unknown>).color_curves as Array<Record<string, unknown>> | undefined) ?? [];
  const transitions = ((content.materials as Record<string, unknown>).transitions as Array<Record<string, unknown>> | undefined) ?? [];

  const effectById = new Map(effects.map((e) => [String(e.id), e]));
  const placeholderById = new Map(placeholders.map((p) => [String(p.id), p]));
  const curveById = new Map(colorCurves.map((c) => [String(c.id), c]));

  const filters: Array<{ name: string; value: number; startSec: number; durationSec: number }> = [];
  const adjustLayers: Array<{
    name: string;
    startSec: number;
    durationSec: number;
    adjustments: Record<string, number>;
    hasCurves: boolean;
  }> = [];

  for (const track of content.tracks) {
    if (track.type === 'filter') {
      for (const seg of track.segments ?? []) {
        const eff = effectById.get(String(seg.material_id));
        const tr = seg.target_timerange as { start?: number; duration?: number } | undefined;
        filters.push({
          name: String(eff?.name || 'Filter'),
          value: Number(eff?.value ?? 1),
          startSec: Number(((tr?.start ?? 0) / US_PER_SEC).toFixed(3)),
          durationSec: Number(((tr?.duration ?? 0) / US_PER_SEC).toFixed(3))
        });
      }
    } else if (track.type === 'adjust') {
      for (const seg of track.segments ?? []) {
        const ph = placeholderById.get(String(seg.material_id));
        const tr = seg.target_timerange as { start?: number; duration?: number } | undefined;
        const refs = Array.isArray(seg.extra_material_refs) ? seg.extra_material_refs.map(String) : [];
        const adjustments: Record<string, number> = {};
        let hasCurves = false;
        for (const refId of refs) {
          const eff = effectById.get(refId);
          if (eff?.type) {
            adjustments[String(eff.type)] = Number(eff.value ?? 0);
          }
          if (curveById.has(refId)) hasCurves = true;
        }
        adjustLayers.push({
          name: String(ph?.name || 'Adjust'),
          startSec: Number(((tr?.start ?? 0) / US_PER_SEC).toFixed(3)),
          durationSec: Number(((tr?.duration ?? 0) / US_PER_SEC).toFixed(3)),
          adjustments,
          hasCurves
        });
      }
    }
  }

  return {
    draftName: String(meta?.draft_name || content.name || path.basename(targetDir)),
    draftPath: targetDir,
    timelineId: content.id,
    durationSec: Number(((content.duration ?? 0) / US_PER_SEC).toFixed(3)),
    fps: content.fps ?? 30,
    resolution: `${content.canvas_config?.width ?? 1920}x${content.canvas_config?.height ?? 1080}`,
    counts: {
      videos: content.materials.videos.length,
      audios: content.materials.audios.length,
      texts: content.materials.texts.length,
      transitions: transitions.length,
      filters: filters.length,
      adjustLayers: adjustLayers.length
    },
    tracks: content.tracks.map((t, index) => ({
      index,
      type: t.type,
      segments: Array.isArray(t.segments) ? t.segments.length : 0
    })),
    filters,
    adjustLayers
  };
}

export async function listCapCutCachedEffects(params: {
  cacheDir?: string;
  limit?: number;
} = {}) {
  const dir = params.cacheDir
    ? resolveSafePath(params.cacheDir)
    : getDefaultCapCutEffectCacheDir();
  if (!dir || !(await fileExists(dir))) {
    throw new Error('CapCut cached effect directory not found. Pass cacheDir explicitly.');
  }

  const limit = Math.min(100, Math.max(1, params.limit ?? 30));
  const entries = await readdir(dir, { withFileTypes: true });
  const bundles: Array<{
    effectId: string;
    bundlePath: string;
    name: string | null;
    hasLumiHub: boolean;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.' || entry.name === '..') continue;
    const idDir = path.join(dir, entry.name);
    try {
      const subEntries = await readdir(idDir, { withFileTypes: true });
      const activeSub = subEntries.find((s) => s.isDirectory() && !s.name.endsWith('_tmp'));
      if (!activeSub) continue;
      const bundlePath = path.join(idDir, activeSub.name).replace(/\\/g, '/');
      let name: string | null = null;
      const cfgPath = path.join(bundlePath, 'config.json');
      if (await fileExists(cfgPath)) {
        try {
          const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
          if (typeof cfg.name === 'string' && cfg.name.trim()) name = cfg.name;
        } catch {
          // Ignore malformed config
        }
      }
      const hasLumiHub = await fileExists(path.join(bundlePath, 'lumi_hub_path'));
      bundles.push({ effectId: entry.name, bundlePath, name, hasLumiHub });
      if (bundles.length >= limit) break;
    } catch {
      // Skip unreadable effect folders
    }
  }

  return { cacheDir: dir.replace(/\\/g, '/'), count: bundles.length, bundles };
}

export type CapCutColorPreset =
  | 'film'
  | 'teal_orange'
  | 'moody'
  | 'warm_golden'
  | 'clean_vivid';

export type CurvePointCoord = [number, number];

/** Accepts [[x,y],...] or flat [x1,y1,x2,y2,...] (flat form keeps Gemini proto schemas valid). */
export type CurvePoints = CurvePointCoord[] | number[];

function normalizeCurvePoints(pts: CurvePoints | undefined): CurvePointCoord[] | undefined {
  if (!pts || pts.length === 0) return undefined;
  if (typeof pts[0] === 'number') {
    const flat = pts as number[];
    const out: CurvePointCoord[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out.length > 0 ? out : undefined;
  }
  return pts as CurvePointCoord[];
}

export interface ColorGradeCurvesInput {
  luma?: CurvePoints;
  red?: CurvePoints;
  green?: CurvePoints;
  blue?: CurvePoints;
}

const COLOR_PRESETS: Record<
  CapCutColorPreset,
  {
    adjustments: Record<string, number>;
    curves: Required<ColorGradeCurvesInput>;
    recommendedFilterIntensity?: number;
  }
> = {
  film: {
    adjustments: {
      temperature: 0.16,
      contrast: 0.12,
      highlight: -0.24,
      shadow: -0.1,
      white: -0.08,
      saturation: -0.1,
      brightness: 0.03,
      sharpen: 0.14
    },
    curves: {
      luma: [[0.0, 0.045], [0.22, 0.19], [0.5, 0.51], [0.78, 0.82], [1.0, 0.955]],
      red: [[0.0, 0.0], [0.3, 0.295], [0.72, 0.74], [1.0, 1.0]],
      green: [[0.0, 0.008], [0.5, 0.5], [1.0, 0.985]],
      blue: [[0.0, 0.035], [0.28, 0.29], [0.72, 0.7], [1.0, 0.935]]
    },
    recommendedFilterIntensity: 0.55
  },
  teal_orange: {
    adjustments: {
      temperature: 0.12,
      contrast: 0.18,
      highlight: -0.18,
      shadow: -0.14,
      saturation: 0.08,
      sharpen: 0.16
    },
    curves: {
      luma: [[0.0, 0.02], [0.25, 0.21], [0.75, 0.79], [1.0, 0.98]],
      red: [[0.0, 0.0], [0.25, 0.21], [0.72, 0.76], [1.0, 1.0]],
      green: [[0.0, 0.01], [0.5, 0.5], [1.0, 0.99]],
      blue: [[0.0, 0.05], [0.28, 0.31], [0.72, 0.67], [1.0, 0.92]]
    }
  },
  moody: {
    adjustments: {
      temperature: -0.1,
      contrast: 0.16,
      highlight: -0.28,
      shadow: -0.18,
      saturation: -0.22,
      brightness: -0.06,
      vignette: 0.18,
      sharpen: 0.12
    },
    curves: {
      luma: [[0.0, 0.03], [0.25, 0.2], [0.75, 0.73], [1.0, 0.92]],
      red: [[0.0, 0.0], [0.5, 0.49], [1.0, 0.96]],
      green: [[0.0, 0.01], [0.5, 0.5], [1.0, 0.97]],
      blue: [[0.0, 0.04], [0.45, 0.47], [1.0, 0.98]]
    }
  },
  warm_golden: {
    adjustments: {
      temperature: 0.26,
      contrast: 0.08,
      highlight: -0.16,
      shadow: 0.08,
      saturation: 0.06,
      brightness: 0.04,
      sharpen: 0.1
    },
    curves: {
      luma: [[0.0, 0.02], [0.3, 0.31], [0.75, 0.8], [1.0, 0.98]],
      red: [[0.0, 0.02], [0.5, 0.53], [1.0, 1.0]],
      green: [[0.0, 0.01], [0.5, 0.51], [1.0, 0.99]],
      blue: [[0.0, 0.0], [0.5, 0.46], [1.0, 0.92]]
    }
  },
  clean_vivid: {
    adjustments: {
      contrast: 0.1,
      highlight: -0.1,
      shadow: 0.1,
      saturation: 0.14,
      brightness: 0.04,
      sharpen: 0.18
    },
    curves: {
      luma: [[0.0, 0.0], [0.25, 0.23], [0.75, 0.78], [1.0, 1.0]],
      red: [[0.0, 0.0], [1.0, 1.0]],
      green: [[0.0, 0.0], [1.0, 1.0]],
      blue: [[0.0, 0.0], [1.0, 1.0]]
    }
  }
};

const ADJUST_VERSION_MAP: Record<string, string> = {
  temperature: 'v3',
  tone: 'v3',
  contrast: 'v3',
  highlight: 'v3',
  shadow: 'v3',
  white: '',
  black: '',
  saturation: 'v1',
  brightness: 'v2',
  sharpen: 'v1',
  fade: 'v1',
  vignette: 'v1',
  grain: 'v1'
};

function buildCurvePoints(coords: CurvePointCoord[]) {
  const n = coords.length;
  return coords.map(([x, y], i) => {
    let lx = x;
    let ly = y;
    let rx = x;
    let ry = y;
    if (i === 0 && n > 1) {
      rx = x + (coords[1][0] - x) * 0.33;
      ry = y + (coords[1][1] - y) * 0.33;
    } else if (i === n - 1 && n > 1) {
      lx = x - (x - coords[n - 2][0]) * 0.33;
      ly = y - (y - coords[n - 2][1]) * 0.33;
    } else if (n > 2) {
      const dx = (coords[i + 1][0] - coords[i - 1][0]) * 0.2;
      const dy = (coords[i + 1][1] - coords[i - 1][1]) * 0.2;
      lx = x - dx;
      ly = y - dy;
      rx = x + dx;
      ry = y + dy;
    }
    return {
      anchor: { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) },
      left_control: { x: Number(lx.toFixed(4)), y: Number(ly.toFixed(4)) },
      right_control: { x: Number(rx.toFixed(4)), y: Number(ry.toFixed(4)) },
      sync_direction_control: true
    };
  });
}

function makeAdjustEffect(
  effType: string,
  value: number,
  bundle: { bundleId: string; bundlePath: string; lumiHubPath: string }
) {
  return {
    id: uuidUpper(),
    effect_id: bundle.bundleId,
    resource_id: bundle.bundleId,
    third_resource_id: '',
    name: '',
    report_name: '',
    type: effType,
    sub_type: 'none',
    path: bundle.bundlePath,
    value,
    visible: true,
    item_effect_type: 0,
    category_id: '',
    category_name: '',
    category_key: '',
    sub_category_id: '',
    sub_category_name: '',
    platform: 'all',
    apply_target_type: 0,
    source_platform: 1,
    version: ADJUST_VERSION_MAP[effType] ?? 'v1',
    adjust_params: [],
    time_range: null,
    formula_id: '',
    enable_skin_tone_correction: false,
    algorithm_artifact_path: '',
    intensity_key: '',
    face_adjust_params: [],
    exclusion_group: [],
    panel_id: '',
    bloom_params: null,
    request_id: '',
    color_match_info: {
      target_feature_path: '',
      source_feature_path: '',
      target_image_path: ''
    },
    multi_language_current: '',
    lumi_hub_path: bundle.lumiHubPath,
    covering_relation_change: 0,
    beauty_face_auto_preset_id: '',
    beauty_body_auto_preset_id: '',
    beauty_face_auto_retouch_info: {
      face_id: [],
      beauty_face_auto_retouch_id: ''
    },
    smart_color_mode: 0,
    is_from_intelligent_quality: false
  };
}

export async function colorGradeCapCutDraft(params: {
  draftPath?: string;
  draftName?: string;
  draftsDir?: string;
  preset?: CapCutColorPreset;
  layerName?: string;
  startSec?: number;
  durationSec?: number;
  adjustments?: Record<string, number>;
  curves?: ColorGradeCurvesInput;
  filterName?: string;
  filterIntensity?: number;
  effectCacheDir?: string;
}) {
  const targetDir = await resolveCapCutDraftPath(params);
  const { contentFile, metaFile, content, meta } = await loadDraft(targetDir);
  const backupContent = await backupIfExists(contentFile);
  const backupMeta = await backupIfExists(metaFile);

  const timelineContentFile = path.join(targetDir, 'Timelines', content.id, 'draft_content.json');
  const backupTimeline = await backupIfExists(timelineContentFile);

  const layerName = params.layerName?.trim() || 'Adjust1';
  const presetSpec = params.preset ? COLOR_PRESETS[params.preset] : undefined;
  const mergedAdjustments: Record<string, number> = {
    ...(presetSpec?.adjustments ?? {}),
    ...(params.adjustments ?? {})
  };
  const mergedCurves: ColorGradeCurvesInput | undefined =
    presetSpec || params.curves
      ? {
          luma: normalizeCurvePoints(params.curves?.luma) ?? presetSpec?.curves.luma ?? [[0, 0], [1, 1]],
          red: normalizeCurvePoints(params.curves?.red) ?? presetSpec?.curves.red ?? [[0, 0], [1, 1]],
          green: normalizeCurvePoints(params.curves?.green) ?? presetSpec?.curves.green ?? [[0, 0], [1, 1]],
          blue: normalizeCurvePoints(params.curves?.blue) ?? presetSpec?.curves.blue ?? [[0, 0], [1, 1]]
        }
      : undefined;

  if (Object.keys(mergedAdjustments).length === 0 && !mergedCurves && params.filterIntensity === undefined) {
    throw new Error('Provide preset, adjustments, curves, or filterIntensity.');
  }

  const mats = content.materials as Record<string, Array<Record<string, unknown>>>;
  mats.effects ??= [];
  mats.placeholders ??= [];
  mats.color_curves ??= [];

  // Idempotently remove any prior automated adjust layer with the same layerName
  const oldPlaceholderIds = new Set(
    mats.placeholders
      .filter((p) => p.type === 'adjust' && p.name === layerName)
      .map((p) => String(p.id))
  );
  const oldRefIds = new Set<string>();
  content.tracks = content.tracks.filter((tr) => {
    if (
      tr.type === 'adjust' &&
      (tr.segments ?? []).some((seg) => oldPlaceholderIds.has(String(seg.material_id)))
    ) {
      for (const seg of tr.segments ?? []) {
        if (Array.isArray(seg.extra_material_refs)) {
          for (const ref of seg.extra_material_refs) oldRefIds.add(String(ref));
        }
      }
      return false;
    }
    return true;
  });
  mats.placeholders = mats.placeholders.filter((p) => !oldPlaceholderIds.has(String(p.id)));
  mats.effects = mats.effects.filter((e) => !oldRefIds.has(String(e.id)));
  mats.color_curves = mats.color_curves.filter((c) => !oldRefIds.has(String(c.id)));

  // Optionally update filter intensity on existing filter track
  let updatedFilter: { name: string; value: number } | null = null;
  const targetIntensity = params.filterIntensity ?? presetSpec?.recommendedFilterIntensity;
  if (targetIntensity !== undefined) {
    const filterEff = mats.effects.find(
      (e) =>
        e.type === 'filter' &&
        (!params.filterName ||
          String(e.name || '').toLowerCase() === params.filterName.toLowerCase())
    );
    if (filterEff) {
      filterEff.value = Math.max(0, Math.min(1, targetIntensity));
      updatedFilter = { name: String(filterEff.name || 'Filter'), value: Number(filterEff.value) };
    }
  }

  const bundle = await resolveAdjustBundle(params.effectCacheDir);
  const newEffectIds: string[] = [];

  for (const [effType, val] of Object.entries(mergedAdjustments)) {
    if (!Number.isFinite(val)) continue;
    const eff = makeAdjustEffect(effType, Number(val), bundle);
    mats.effects.push(eff);
    newEffectIds.push(eff.id);
  }

  let hasCurves = false;
  if (mergedCurves) {
    const curveId = uuidUpper();
    mats.color_curves.push({
      id: curveId,
      type: 'color_curves',
      panel: 'adjust_collection',
      path: bundle.bundlePath,
      lumi_hub_path: bundle.lumiHubPath,
      resource_id: bundle.bundleId,
      link_status: false,
      select_channel: 0,
      source_platform: 1,
      luma: buildCurvePoints(normalizeCurvePoints(mergedCurves.luma) ?? [[0, 0], [1, 1]]),
      red: buildCurvePoints(normalizeCurvePoints(mergedCurves.red) ?? [[0, 0], [1, 1]]),
      green: buildCurvePoints(normalizeCurvePoints(mergedCurves.green) ?? [[0, 0], [1, 1]]),
      blue: buildCurvePoints(normalizeCurvePoints(mergedCurves.blue) ?? [[0, 0], [1, 1]])
    });
    newEffectIds.push(curveId);
    hasCurves = true;
  }

  const totalDraftUs = Math.max(recomputeDurationUs(content), 1);
  const startUs = toUs(params.startSec ?? 0);
  const durationUs =
    params.durationSec !== undefined
      ? toUs(params.durationSec)
      : Math.max(1, totalDraftUs - startUs);

  if (newEffectIds.length > 0) {
    const placeholderId = uuidUpper();
    mats.placeholders.push({
      id: placeholderId,
      name: layerName,
      type: 'adjust',
      material_resource_id: ''
    });

    const adjustTrack: DraftTrack = {
      id: uuidUpper(),
      type: 'adjust',
      flag: 0,
      attribute: 0,
      name: '',
      is_default_name: true,
      segments: [
        {
          id: uuidUpper(),
          source_timerange: null,
          target_timerange: { start: startUs, duration: durationUs },
          render_timerange: { start: 0, duration: 0 },
          desc: '',
          state: 0,
          speed: 1,
          is_loop: false,
          is_tone_modify: false,
          reverse: false,
          intensifies_audio: false,
          cartoon: false,
          volume: 1,
          last_nonzero_volume: 1,
          clip: null,
          uniform_scale: null,
          material_id: placeholderId,
          extra_material_refs: newEffectIds,
          render_index: 0,
          keyframe_refs: [],
          enable_lut: true,
          enable_adjust: true,
          enable_hsl: true,
          visible: true,
          group_id: '',
          enable_color_curves: true,
          enable_hsl_curves: true,
          track_render_index: 0,
          hdr_settings: null,
          hdr_vivid_settings: null,
          enable_color_wheels: true,
          track_attribute: 0,
          is_placeholder: false,
          template_id: '',
          enable_smart_color_adjust: false,
          template_scene: 'default',
          common_keyframes: [],
          caption_info: null,
          responsive_layout: {
            enable: false,
            target_follow: '',
            size_layout: 0,
            horizontal_pos_layout: 0,
            vertical_pos_layout: 0
          },
          enable_color_match_adjust: false,
          enable_color_correct_adjust: false,
          enable_adjust_mask: false,
          raw_segment_id: '',
          lyric_keyframes: null,
          enable_video_mask: true,
          digital_human_template_group_id: '',
          color_correct_alg_result: '',
          source: 'segmentsourcenormal',
          enable_mask_stroke: false,
          enable_mask_shadow: false,
          enable_color_adjust_pro: false,
          segment_color_tag: ''
        }
      ]
    };

    const filterIdx = content.tracks.findIndex((t) => t.type === 'filter');
    if (filterIdx >= 0) {
      content.tracks.splice(filterIdx + 1, 0, adjustTrack);
    } else {
      const videoIdx = content.tracks.findIndex((t) => t.type === 'video');
      content.tracks.splice(videoIdx >= 0 ? videoIdx + 1 : 0, 0, adjustTrack);
    }
  }

  // Keep track_render_index consistent across tracks
  content.tracks.forEach((tr, idx) => {
    for (const seg of tr.segments ?? []) {
      if ('track_render_index' in seg) {
        seg.track_render_index = idx;
      }
    }
  });

  const finalDurationUs = await persistDraftMutation({
    draftPath: targetDir,
    contentFile,
    metaFile,
    content,
    meta
  });

  return {
    draftPath: targetDir,
    preset: params.preset ?? 'custom',
    layerName,
    appliedAdjustments: mergedAdjustments,
    hasCurves,
    updatedFilter,
    startSec: Number((startUs / US_PER_SEC).toFixed(3)),
    durationSec: Number((durationUs / US_PER_SEC).toFixed(3)),
    totalDurationSec: Number((finalDurationUs / US_PER_SEC).toFixed(3)),
    backups: [backupContent, backupMeta, backupTimeline].filter(Boolean)
  };
}

/**
 * Estimate the largest safe clip scale for a text block so its longest line fits the canvas.
 * pyCapCut computes this from real font metrics; we only have char counts, so the 10 px-per-char
 * factor is calibrated against a 1920x1080 draft at font_size 5.6 (40 chars * 5.6 * 10 * 0.75 = 1680px,
 * inside 1728px). Advisory, clamped to the safe band 0.4–0.8.
 * ponytail: replace the 10x factor with a metrics table only if a non-1920 canvas mis-fits in practice.
 */
function fitTextScale(
  text: string,
  opts: { canvasWidth: number; fontSize: number; maxWidthRatio: number }
): number {
  const longest = Math.max(1, ...text.split('\n').map((l) => l.trim().length));
  const targetPx = opts.canvasWidth * Math.min(Math.max(opts.maxWidthRatio, 0.5), 1);
  const pxPerCharAtScale1 = longest * Math.max(opts.fontSize, 1) * 10;
  const scale = targetPx / pxPerCharAtScale1;
  return Math.min(0.8, Math.max(0.4, scale));
}

export interface AdjustTimingParams {
  draftPath?: string;
  draftName?: string;
  draftsDir?: string;
  transitionDurations?: number[];
  transitionUniformSec?: number;
  transitionRandomRange?: { minSec: number; maxSec: number };
  shiftTextSec?: number;
  avoidTransitionsForTexts?: boolean;
  textMinGapAfterTransitionSec?: number;
  autoCloseCapCut?: boolean;
  autoReopenCapCut?: boolean;
  // pyCapCut-style safe text styling: scale <= 0.8 prevents 16:9 canvas clipping
  textSafeScale?: number;
  textYTransform?: number;
  textFontSize?: number;
  /** Derive each block's scale from its own longest line (pyCapCut bounding-box fit) instead of one constant. */
  textAutoFit?: boolean;
  /** Fraction of canvas width text may occupy when textAutoFit is on (default 0.9). */
  textMaxWidthRatio?: number;
  textAdjustments?: Array<{
    index?: number;
    startSec?: number;
    durationSec?: number;
  }>;
}

export async function adjustCapCutTiming(params: AdjustTimingParams) {
  const shouldClose = params.autoCloseCapCut !== false;
  let wasClosed = false;
  if (shouldClose) {
    wasClosed = await closeCapCutDesktop();
    if (wasClosed) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  const targetDir = await resolveCapCutDraftPath(params);
  const { contentFile, metaFile, content, meta } = await loadDraft(targetDir);
  const backupContent = await backupIfExists(contentFile);
  const backupMeta = await backupIfExists(metaFile);

  const timelineContentFile = path.join(targetDir, 'Timelines', content.id, 'draft_content.json');
  const backupTimeline = await backupIfExists(timelineContentFile);

  const mats = content.materials as Record<string, Array<Record<string, unknown>>>;
  mats.transitions ??= [];
  const canvasWidth = Number(content.canvas_config?.width ?? 1920) || 1920;
  const adjustedTransitions: Array<{
    index: number;
    id: string;
    name: string;
    oldDurationSec: number;
    newDurationSec: number;
  }> = [];

  // 1. Determine transition target durations if requested
  if (
    params.transitionDurations?.length ||
    params.transitionUniformSec !== undefined ||
    params.transitionRandomRange
  ) {
    const transList = mats.transitions;
    transList.forEach((t, i) => {
      let targetSec: number | null = null;
      if (params.transitionDurations && params.transitionDurations.length > 0) {
        targetSec = params.transitionDurations[i % params.transitionDurations.length];
      } else if (params.transitionUniformSec !== undefined) {
        targetSec = params.transitionUniformSec;
      } else if (params.transitionRandomRange) {
        const { minSec, maxSec } = params.transitionRandomRange;
        const step = transList.length > 1 ? (maxSec - minSec) / (transList.length - 1) : 0;
        const staggered = minSec + ((i * 3) % transList.length) * (step || 0);
        targetSec = Math.round(staggered * 100) / 100;
      }

      if (targetSec !== null && targetSec > 0) {
        const oldDurUs = Number(t.duration ?? 0);
        const newDurUs = toUs(targetSec);
        t.duration = newDurUs;
        if ('transition_duration' in t) {
          t.transition_duration = newDurUs;
        }
        adjustedTransitions.push({
          index: i,
          id: String(t.id ?? ''),
          name: String(t.name ?? 'Transition'),
          oldDurationSec: Number((oldDurUs / US_PER_SEC).toFixed(3)),
          newDurationSec: Number((newDurUs / US_PER_SEC).toFixed(3))
        });
      }
    });

    for (const tr of content.tracks) {
      for (const seg of tr.segments ?? []) {
        if (seg.transition && typeof seg.transition === 'object') {
          const segTr = seg.transition as Record<string, unknown>;
          const match = adjustedTransitions.find((at) => at.id === String(segTr.id));
          if (match) {
            segTr.duration = toUs(match.newDurationSec);
          }
        }
      }
    }
  }

  // 2. Identify transition windows on video tracks
  interface TransWindow {
    cutUs: number;
    startUs: number;
    endUs: number;
  }
  const transWindows: TransWindow[] = [];

  for (const tr of content.tracks) {
    if (tr.type === 'video') {
      const segs = tr.segments ?? [];
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const timerange = s.target_timerange as { start?: number; duration?: number } | undefined;
        if (!timerange) continue;
        const segStart = timerange.start ?? 0;
        const segDur = timerange.duration ?? 0;
        const cutUs = segStart + segDur;

        const refs = Array.isArray(s.extra_material_refs) ? s.extra_material_refs.map(String) : [];
        const hasTrans = mats.transitions.some((t) => refs.includes(String(t.id)));

        if (hasTrans) {
          const transMat = mats.transitions.find((t) => refs.includes(String(t.id)));
          const transDurUs = Number(transMat?.duration ?? toUs(0.5));
          if (segStart < toUs(0.1)) {
            transWindows.push({
              cutUs: segStart,
              startUs: 0,
              endUs: transDurUs
            });
          }
          if (i < segs.length - 1) {
            const halfUs = Math.round(transDurUs / 2);
            transWindows.push({
              cutUs,
              startUs: Math.max(0, cutUs - halfUs),
              endUs: cutUs + halfUs
            });
          }
        }
      }
    }
  }

  // 3. Adjust text tracks
  const styleAdjustedTexts: Array<{ index: number; id: string }> = [];
  const textOverlaps: Array<{
    index: number;
    id: string;
    text: string;
    startSec: number;
    endSec: number;
    transitionStartSec: number;
    transitionEndSec: number;
  }> = [];
  const adjustedTexts: Array<{
    index: number;
    id: string;
    text: string;
    oldStartSec: number;
    newStartSec: number;
    durationSec: number;
  }> = [];

  const textMats = (mats.texts ?? []) as Array<Record<string, unknown>>;
  const textMatById = new Map(textMats.map((m) => [String(m.id), m]));

  let textIndex = 0;
  for (const tr of content.tracks) {
    if (tr.type === 'text') {
      for (const seg of tr.segments ?? []) {
        const timerange = seg.target_timerange as { start?: number; duration?: number } | undefined;
        if (!timerange) continue;

        const oldStartUs = timerange.start ?? 0;
        let newStartUs = oldStartUs;
        let newDurUs = timerange.duration ?? 0;

        const mat = textMatById.get(String(seg.material_id));
        let textSnippet = '';
        let textRaw = '';
        if (mat?.content && typeof mat.content === 'string') {
          try {
            const parsedContent = JSON.parse(mat.content);
            textRaw = String(parsedContent?.text || '');
            textSnippet = textRaw;
          } catch {
            textSnippet = '';
          }
        }

        // Safe-scale + reposition text clip (prevents horizontal clipping past 1920px canvas).
        // autoFit derives the scale from this block's own longest line (pyCapCut bounding-box fit)
        // instead of one constant guess; textSafeScale is the manual override / fallback.
        const clip = seg.clip as { scale?: { x: number; y: number }; transform?: { x: number; y: number } } | undefined;
        if (clip) {
          let clipChanged = false;
          let targetScale: number | undefined;
          if (params.textAutoFit && textRaw) {
            targetScale = fitTextScale(textRaw, {
              canvasWidth,
              fontSize: params.textFontSize ?? Number(mat?.font_size ?? 7),
              maxWidthRatio: params.textMaxWidthRatio ?? 0.9
            });
          } else if (params.textSafeScale !== undefined) {
            targetScale = Math.min(params.textSafeScale, 0.8);
          }
          if (targetScale !== undefined && clip.scale) {
            const s = Number(targetScale.toFixed(3));
            if (clip.scale.x !== s || clip.scale.y !== s) {
              clip.scale = { x: s, y: s };
              clipChanged = true;
            }
          }
          if (params.textYTransform !== undefined && clip.transform) {
            if (clip.transform.y !== params.textYTransform) {
              clip.transform.y = params.textYTransform;
              clipChanged = true;
            }
          }
          if (clipChanged) {
            styleAdjustedTexts.push({ index: textIndex, id: String(seg.id ?? '') });
          }
        }

        if (params.textFontSize !== undefined && mat) {
          mat.font_size = params.textFontSize;
          // CapCut renders from content.styles[].size; font_size alone is ignored by the renderer.
          if (typeof mat.content === 'string') {
            try {
              const parsed = JSON.parse(mat.content) as {
                styles?: Array<{ size?: number }>;
              };
              if (Array.isArray(parsed.styles)) {
                for (const st of parsed.styles) st.size = params.textFontSize;
                mat.content = JSON.stringify(parsed);
              }
            } catch {
              // leave malformed content untouched
            }
          }
        }

        if (params.shiftTextSec !== undefined) {
          newStartUs = Math.max(0, newStartUs + toUs(params.shiftTextSec));
        }

        if (params.avoidTransitionsForTexts) {
          // Only the text's START matters: the text track renders above the video track, so a block
          // spanning a transition is fine, but one whose start lands inside the window pops in mid-blend.
          // Shift iteratively — clearing one window can land inside the next (cli-anything gap-detect).
          const gapUs = toUs(params.textMinGapAfterTransitionSec ?? 0.2);
          const sorted = [...transWindows].sort((a, b) => a.startUs - b.startUs);
          for (let pass = 0; pass < sorted.length + 1; pass++) {
            const hit = sorted.find((w) => newStartUs >= w.startUs && newStartUs < w.endUs + gapUs);
            if (!hit) break;
            newStartUs = hit.endUs + gapUs;
          }
        }

        if (params.textAdjustments && params.textAdjustments.length > 0) {
          const match = params.textAdjustments.find((adj) => adj.index === textIndex);
          if (match) {
            if (match.startSec !== undefined) newStartUs = toUs(match.startSec);
            if (match.durationSec !== undefined) newDurUs = toUs(match.durationSec);
          }
        }

        if (newStartUs !== oldStartUs || newDurUs !== (timerange.duration ?? 0)) {
          timerange.start = newStartUs;
          timerange.duration = newDurUs;
          adjustedTexts.push({
            index: textIndex,
            id: String(seg.id ?? ''),
            text: textSnippet.slice(0, 30),
            oldStartSec: Number((oldStartUs / US_PER_SEC).toFixed(3)),
            newStartSec: Number((newStartUs / US_PER_SEC).toFixed(3)),
            durationSec: Number((newDurUs / US_PER_SEC).toFixed(3))
          });
        }

        // Post-mutation verification (cli-anything-capcut gap-detect): flag any text whose START is
        // still inside a transition window. Blocks merely spanning a window are not reported — the
        // text track composites above video, so only the entry moment is affected.
        for (const w of transWindows) {
          if (newStartUs >= w.startUs && newStartUs < w.endUs) {
            textOverlaps.push({
              index: textIndex,
              id: String(seg.id ?? ''),
              text: textSnippet.slice(0, 30),
              startSec: Number((newStartUs / US_PER_SEC).toFixed(3)),
              endSec: Number(((newStartUs + newDurUs) / US_PER_SEC).toFixed(3)),
              transitionStartSec: Number((w.startUs / US_PER_SEC).toFixed(3)),
              transitionEndSec: Number((w.endUs / US_PER_SEC).toFixed(3))
            });
            break;
          }
        }

        textIndex++;
      }
    }
  }

  const finalDurationUs = await persistDraftMutation({
    draftPath: targetDir,
    contentFile,
    metaFile,
    content,
    meta,
    manageCapCut: false // already closed at the top of this function
  });

  return {
    draftName: String(meta?.draft_name || content.name || path.basename(targetDir)),
    draftPath: targetDir,
    totalDurationSec: Number((finalDurationUs / US_PER_SEC).toFixed(3)),
    adjustedTransitionsCount: adjustedTransitions.length,
    adjustedTransitions,
    adjustedTextsCount: adjustedTexts.length,
    adjustedTexts,
    styledTextsCount: styleAdjustedTexts.length,
    styledTexts: styleAdjustedTexts,
    textOverlapCount: textOverlaps.length,
    textOverlaps,
    backups: [backupContent, backupMeta, backupTimeline].filter(Boolean),
    capcutClosed: wasClosed,
    capcutReopened:
      params.autoReopenCapCut !== false && (wasClosed || params.autoReopenCapCut === true)
        ? await openCapCutDesktop()
        : false
  };
}
