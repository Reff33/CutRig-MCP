import crypto from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backupIfExists, fileExists, resolveSafePath } from '../utils/safety.js';
import { probeMedia } from './ffmpeg.js';

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
    }
  };

  const meta = {
    draft_id: draftId,
    draft_name: safeName,
    draft_fold_path: draftPath.replace(/\\/g, '/'),
    draft_root_path: baseDir.replace(/\\/g, '/'),
    draft_new_version: '187.0.0',
    draft_materials: [
      { type: 0, value: [] },
      { type: 1, value: [] },
      { type: 2, value: [] }
    ],
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_duration: 0
  };

  await Promise.all([
    writeFile(contentFile, JSON.stringify(content, null, 2), 'utf8'),
    writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  ]);

  return { draftId, name: safeName, draftPath, width, height, fps, backups };
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

export async function insertClipsToCapCutDraft(params: {
  draftPath: string;
  clips: Array<{
    path: string;
    trackType?: 'video' | 'audio';
    startSec?: number;
    trimStartSec?: number;
    durationSec?: number;
    volume?: number;
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

      track.segments.push({
        id: uuidUpper(),
        material_id: materialId,
        source_timerange: { start: toUs(trimStartSec), duration: durUs },
        target_timerange: { start: startUs, duration: durUs },
        speed: 1,
        volume: clip.volume ?? 1,
        extra_material_refs: [speedId]
      });
    }

    inserted.push({
      path: resolvedClip,
      trackType,
      startSec: Number((startUs / US_PER_SEC).toFixed(3)),
      durationSec
    });
  }

  const totalUs = recomputeDurationUs(content);
  const writes: Array<Promise<void>> = [
    writeFile(contentFile, JSON.stringify(content, null, 2), 'utf8')
  ];
  if (meta) {
    meta.tm_duration = totalUs;
    meta.tm_draft_modified = Date.now() * 1000;
    writes.push(writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8'));
  }
  await Promise.all(writes);

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
  items: Array<{
    text: string;
    startSec: number;
    durationSec: number;
    fontSize?: number;
    colorRgb?: [number, number, number];
    yOffset?: number;
  }>;
}) {
  if (params.items.length === 0) throw new Error('Provide at least one text item.');

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

  for (const item of params.items) {
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

  const totalUs = recomputeDurationUs(content);
  const writes: Array<Promise<void>> = [
    writeFile(contentFile, JSON.stringify(content, null, 2), 'utf8')
  ];
  if (meta) {
    meta.tm_duration = totalUs;
    meta.tm_draft_modified = Date.now() * 1000;
    writes.push(writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8'));
  }
  await Promise.all(writes);

  return {
    draftPath: resolveSafePath(params.draftPath),
    addedCount: params.items.length,
    totalDurationSec: Number((totalUs / US_PER_SEC).toFixed(3)),
    backups: [backupContent, backupMeta].filter(Boolean)
  };
}
