# Product Requirements Document (PRD) — CutRig MCP

## 1. Product Vision
**CutRig MCP** is a cross-platform (Windows & Linux) Model Context Protocol (MCP) server and AI skill pack that enables AI coding/creative agents (Claude Code, Cursor, VS Code Copilot, OpenCode) to perform precise, repeatable **video editing, timeline assembly, audio/subtitle mastering, and multi-editor automation** from natural language.

### 1.1 Clear Boundaries (No Overlap With Sibling Rigs)
- **CutRig MCP (This Project):** Edits real footage, cuts timelines, syncs audio/beat/captions, transforms aspect ratios, drives NLE project files/APIs (FFmpeg, CapCut drafts, Premiere Pro, After Effects, DaVinci Resolve), and exports deliverables.
- **KinetRig (`Reff33/KinetRig`):** Generates code-driven 144–240 FPS HTML5/GSAP/Three.js motion graphics & openers. Output clips from `KinetRig` can be imported into `CutRig MCP` timelines automatically when both skills are active in a project.
- **AppRig / Desktop MCP (Optional Companion):** Handles generic OS GUI clicks when an editor lacks a headless export button. Never bundled inside `CutRig-MCP`.

---

## 2. Target Users & Platforms
- **Primary Users:** Video editors, content creators, automation builders, and AI-assisted developers running Claude Code / Cursor / MCP clients.
- **OS Matrix:**
  - **Core Engine (FFmpeg + Whisper + CapCut Draft JSON + DaVinci Resolve):** Windows 10/11 & Linux (Ubuntu/Debian/Arch).
  - **Adobe Bridge (Premiere Pro & After Effects):** Windows 10/11 & macOS (graceful capability skip on Linux with automatic FFmpeg fallback).

---

## 3. Core Architecture — Adapter Pattern & Live Upstream Strategy
Instead of bundling or copy-pasting third-party repositories statically, **CutRig MCP** acts as a unified MCP router over lightweight adapters that pull maintained upstream packages via `npm` / `pip` / `uvx`:

| Adapter Lane | Target Software / Engine | Mechanism | OS Support | Upstream Dependency Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **Core Universal** | FFmpeg + `ffprobe` + Whisper | Subprocess CLI / JSON filters | Windows, Linux | System `ffmpeg` + pinned `faster-whisper` / `whisper.cpp` |
| **CapCut Drafts** | CapCut Desktop | Local `draft_content.json` manipulation | Windows (+ cross-OS draft prep) | Dependency/wrapper around maintained draft package (`capcut-cli` / `pyJianYingDraft` pinned minor) |
| **DaVinci Resolve** | DaVinci Resolve Studio / Free | Resolve Scripting API / bridge | Windows, Linux | Optional adapter delegating to `davinci-resolve-mcp` / Resolve Python API |
| **Adobe NLE/VFX** | Premiere Pro (25.6+) & After Effects (2023+) | ExtendScript JSX & UXP bridge | Windows (skipped on Linux) | Optional adapter delegating to `adobe-mcp` / `Flue` |

### 3.1 Dependency & Upstream Update Policy
1. **No vendored third-party forks:** Never copy third-party source folders into `CutRig-MCP`. Declare them in `package.json` / `pyproject.toml` using safe minor-range pins (`^major.minor`) or invoke via `npx -y` / `uvx`.
2. **Capability Probing (`cutrig_doctor`):** At startup or on demand, probe installed tools (`ffmpeg`, `ffprobe`, Python version, Resolve, Premiere, After Effects, CapCut draft folder) and return structured JSON capabilities—never guess or silently fail.
3. **Graceful Degradation:** If Premiere or CapCut is unavailable (e.g., headless Linux server), route cut/crop/caption/grade/render requests cleanly to the Core FFmpeg lane or fail with an explicit actionable fix.

---

## 4. Functional Requirements

### 4.1 MCP Tool Groups (Unified Surface)
1. **Environment & Discovery (`doctor`, `probe_media`, `list_projects`):**
   - Inspect OS, available adapters, codec/GPU encoders (`h264_nvenc`, `libx264`), video/audio metadata, FPS, duration, and resolution.
2. **Core FFmpeg & AI Editing (`trim_clip`, `concat_clips`, `reframe_aspect`, `normalize_audio`, `auto_captions`, `burn_subtitles`, `overlay_asset`, `color_grade`, `beat_cut`):**
   - Multi-clip trim/stitch with `xfade` transitions.
   - Smart reframe (`16:9` <-> `9:16` / `1:1` / `4:5`).
   - Audio loudness normalization (`loudnorm` LUFS), background music ducking, and local Whisper speech-to-SRT/ASS captions.
3. **NLE Draft & Bridge Operations (`capcut_create_draft`, `capcut_add_clips`, `capcut_add_text`, `resolve_timeline_op`, `adobe_run_action`):**
   - Construct or modify timelines with exact millisecond/frame timestamps.
   - Support multi-track placement (e.g., inserting a `KinetRig` opener MP4 onto Track 1 + voiceover on Track A1).
4. **Preview & Safe Export (`extract_preview_frames`, `export_video`):**
   - Extract keyframe thumbnails so vision-capable AI agents can inspect cuts/captions before full render.
   - Export presets (`tiktok_1080x1920`, `youtube_4k`, `reels_60fps`, `draft_only`).

### 4.2 Safety, Undo & Data Integrity Guardrails
1. **Non-Destructive by Default:** Never overwrite original source footage or existing NLE project files in place; always create timestamped backups (`*.bak`) or write to a new output file/draft copy.
2. **Path Sandboxing:** Reject path traversal (`..`), block sensitive paths (`.env`, `.git`, keys), and validate media extensions before invoking FFmpeg or ExtendScript.
3. **Dry-Run / Plan Mode:** Any destructive or multi-minute batch render exposes a preview plan (estimated duration, commands, output paths) before execution.
4. **No Silent Telemetry:** Zero hidden analytics trackers (no PostHog/Mixpanel) in `CutRig-MCP`.

### 4.3 ContextRig Integration Contract
- Ships a standard `SKILL.md` + `references/` per editor (`capcut.md`, `premiere.md`, `after-effects.md`, `davinci.md`, `ffmpeg.md`) so `CLAUDE.md` stays compact and loads editor-specific shortcuts/rules on demand.
- Exposes `settings_schema` for `ContextRig`:
  - `defaultEditor`: `auto | ffmpeg | capcut | premiere | aftereffects | davinci`
  - `defaultAspect`: `16:9 | 9:16 | 1:1 | 4:5`
  - `encoder`: `auto | nvenc | qsv | amf | cpu`
  - `outputDir`: default `cutrig-out`
- Registers cleanly in project `.mcp.json` once `ContextRig` adds `mcp_servers` injection support.

---

## 5. Non-Functional Requirements & Acceptance Criteria
- **Zero-Config Core:** Works out of the box on Windows & Linux as long as Node.js 20+ (or Python 3.10+) and `ffmpeg` are on `PATH`.
- **Latency:** `doctor` and `probe_media` return in `< 500 ms`; FFmpeg cuts use `-c copy` stream copy whenever re-encoding is unnecessary.
- **Testability:** Automated unit + integration tests covering path validation, FFmpeg command generation, mocked CapCut draft JSON mutation, and MCP tool schema validation (`npm test` / `pytest`).
- **License:** MIT License (keeping GPL binaries like `ffmpeg` as external subprocesses only).
