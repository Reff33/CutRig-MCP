# CutRig-MCP

Cross-platform Model Context Protocol (MCP) server & AI skill pack for **automated video editing, timeline assembly, AI captions, and NLE bridges** (FFmpeg, CapCut drafts, DaVinci Resolve, Adobe Premiere Pro, After Effects) on **Windows & Linux**.

---

## OS & Adapter Matrix

| Adapter Lane | Target Software | Mechanism | Windows | Linux |
| :--- | :--- | :--- | :---: | :---: |
| **Core Universal** | FFmpeg + `ffprobe` + Whisper | Subprocess CLI & filtergraphs | ✅ | ✅ |
| **CapCut Drafts** | CapCut Desktop | Local `draft_content.json` + `.bak` | ✅ | ✅ *(portable draft prep)* |
| **DaVinci Resolve** | DaVinci Resolve Studio / Free | Python Scripting API | ✅ | ✅ |
| **Adobe NLE/VFX** | Premiere Pro & After Effects | ExtendScript `.jsx` & `aerender` | ✅ | ⏭️ *(graceful FFmpeg fallback)* |

---

## Prerequisites

- **Required:** Node.js `>= 20.0.0`, `ffmpeg` & `ffprobe` on `PATH`
- **Optional (AI Captions):** `pip install faster-whisper` (or `openai-whisper` / `whisper-cli` on `PATH`)
- **Optional (DaVinci Resolve):** Resolve Preferences → System → General → *External scripting using = Local*

---

## Quickstart

### 1. Local Build

```bash
npm install
npm run build
npm test
```

### 2. Connect to Claude Code / MCP Clients

Add to your project `.mcp.json`:

```json
{
  "mcpServers": {
    "cutrig": {
      "command": "npx",
      "args": ["-y", "github:Reff33/CutRig-MCP#testing"]
    }
  }
}
```

Or register globally via Claude Code CLI:

```bash
claude mcp add cutrig -- node /absolute/path/to/CutRig-MCP/dist/index.js
```

---

## Available MCP Tools (16)

### Environment & Inspection

- `cutrig_doctor` — Probe OS, FFmpeg/ffprobe, GPU encoders (`nvenc`/`qsv`/`amf`/`vaapi`), Whisper, Python, CapCut, Resolve, and Adobe paths.
- `cutrig_probe_media` — Extract codec, resolution, FPS, duration, and audio stream metadata.
- `cutrig_preview_frames` — Extract evenly spaced PNG keyframes for visual QA before/after rendering.

### Core FFmpeg Editing

- `cutrig_trim` — Fast `-c copy` or frame-accurate re-encode trim (`dryRun` supported).
- `cutrig_concat` — Join 2+ clips, auto-normalizing resolution/FPS and padding silent clips (`KinetRig` renders) with optional `xfade` transitions.
- `cutrig_reframe` — Convert `16:9`, `9:16`, `1:1`, or `4:5` via `crop` or `blur_pad`.
- `cutrig_audio_mix` — LUFS loudness normalization (`loudnorm`) + BGM mixing & `sidechaincompress` ducking.

### AI Captions & Subtitles

- `cutrig_auto_captions` — Local Whisper speech-to-SRT & styled ASS (`tiktok_bold`, `minimal`, `default`).
- `cutrig_burn_subtitles` — Hard-render `.srt`/`.ass` onto video with safe Windows/Linux filter path escaping.

### CapCut Drafts

- `cutrig_capcut_list_drafts` — Inspect local CapCut draft folders, durations, and track counts.
- `cutrig_capcut_create_draft` — Initialize `draft_content.json` + `draft_meta_info.json`.
- `cutrig_capcut_insert_clips` — Probe & insert video/audio clips onto CapCut tracks (writes `.bak` first).
- `cutrig_capcut_add_text` — Insert timed text/caption layers onto CapCut text track (writes `.bak` first).

### DaVinci Resolve & Adobe Bridges

- `cutrig_resolve_action` — `get_status`, `list_projects`, `create_timeline`, `import_media`, `render_timeline`.
- `cutrig_adobe_premiere` — Generate sandboxed ExtendScript `.jsx` (`import_media`, `add_marker`, `apply_mogrt`, `export_sequence`).
- `cutrig_ae_render` — Headless `aerender` composition render with collision-safe output paths.

---

## Safety & Pairing

- **Non-Destructive by Default:** Never overwrites original media; output collisions auto-suffix (`_1`, `_2`) unless `overwrite: true` (which creates a timestamped `.bak` snapshot).
- **Path Sandboxing:** Blocks `.env`, `.git`, `.ssh`, private keys (`*.pem`/`*.key`), and path escapes.
- **Sibling Rigs:** Pair with [KinetRig](https://github.com/Reff33/KinetRig) for HTML5/GSAP motion openers and [ContextRig](https://github.com/Reff33/ContextRig) for one-command project injection.
