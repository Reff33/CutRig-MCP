# Development Plan — CutRig MCP

## Tech Stack Decision
- **Primary Runtime:** TypeScript / Node.js 20+ using `@modelcontextprotocol/sdk` (`stdio` transport, cross-platform `npx` friendly for Windows & Linux, matching `ContextRig` and `KinetRig`).
- **Optional Python Worker:** Python 3.10+ helper (invoked only for CapCut draft Python bridge or Whisper/librosa extras when installed).
- **External Binaries:** `ffmpeg` + `ffprobe` on `PATH` (subprocess only, never bundled).

---

## Phase 0 — Repository Scaffolding & Contracts (Day 1)
1. Initialize `package.json` (`type: module`), `tsconfig.json`, `LICENSE` (MIT), `.gitignore`, and directory layout:
   - `src/index.ts` — MCP stdio server entrypoint
   - `src/tools/` — Tool handlers (`doctor`, `media`, `edit`, `captions`, `nle`)
   - `src/adapters/` — `ffmpeg.ts`, `capcut.ts`, `resolve.ts`, `adobe.ts`
   - `src/utils/` — Path sandbox validator, subprocess runner, backup helper
   - `skills/` — `SKILL.md` + `references/{ffmpeg,capcut,premiere,after-effects,davinci}.md`
   - `tests/` — Automated integration & unit tests
2. Configure ESLint / TypeScript strict mode and CI matrix (GitHub Actions: `windows-latest` + `ubuntu-latest`).

## Phase 1 — Core MCP Server & FFmpeg Lane (Days 2–4)
1. Implement `src/utils/safety.ts`:
   - Path normalization & workspace boundary enforcement
   - Output collision protection (auto-suffix / `.bak` backup)
2. Implement `cutrig_doctor` & `cutrig_probe_media`:
   - Detect OS (`win32` / `linux`), `ffmpeg`, `ffprobe`, GPU encoders (`nvenc`/`vaapi`/`cpu`), Python, and installed NLEs.
   - Return structured JSON stream metadata (codec, fps, duration, resolution, audio channels).
3. Implement core FFmpeg tools (`src/adapters/ffmpeg.ts`):
   - `cutrig_trim` (fast stream-copy or frame-accurate re-encode)
   - `cutrig_concat` (normalize resolution/fps + optional `xfade` transition)
   - `cutrig_reframe` (`16:9`, `9:16`, `1:1`, `4:5` with smart crop/blur-pad background)
   - `cutrig_audio_mix` (LUFS normalization + BGM ducking)
   - `cutrig_preview_frames` (extract PNG keyframes for AI visual QA)
4. Write Phase 1 tests generating synthetic test clips via FFmpeg `testsrc`/`sine` lavfi filters so CI runs offline with zero sample video assets.

## Phase 2 — AI Captions & CapCut Draft Adapter (Days 5–7)
1. Implement `cutrig_auto_captions` & `cutrig_burn_subtitles`:
   - Run local Whisper (`whisper.cpp` / `faster-whisper`) to generate `.srt`/`.ass` with styled karaoke/highlight presets.
2. Implement `src/adapters/capcut.ts`:
   - Auto-discover CapCut drafts directory on Windows (`%LocalAppData%\CapCut\User Data\Projects\com.lveditor.draft`).
   - Bridge cleanly to maintained upstream draft engine (`capcut-cli` / `pyJianYingDraft`) without vendoring static forks.
   - Support `capcut_create_draft`, `capcut_insert_clips`, `capcut_add_text_track`, and automatic `.bak` snapshot before every write.
3. Add Phase 2 unit tests with fixture `draft_content.json` validation.

## Phase 3 — DaVinci Resolve & Adobe (Premiere / After Effects) Adapters (Days 8–10)
1. Implement `src/adapters/resolve.ts` (Windows + Linux):
   - Probe Resolve Scripting API availability; delegate timeline/render actions to `davinci-resolve-mcp` protocol or Resolve Python bridge.
2. Implement `src/adapters/adobe.ts` (Windows; graceful skip on Linux):
   - Detect Premiere Pro UXP / After Effects ExtendScript availability (`adobe-mcp` / `Flue` compatible bridge).
   - Provide safe presets: import media/KinetRig renders, drop `.mogrt`, marker sync, and `aerender` / Media Encoder handoff.
3. Implement `SKILL.md` + per-editor `references/*.md` playbooks (including exact keyboard shortcuts for optional `AppRig` GUI fallback).

## Phase 4 — ContextRig Integration & Release (Days 11–12)
1. Upgrade `ContextRig` (`src/core/fileInjector.js`, `src/core/skillUpdater.js`, `src/core/skillImporter.js`) to support `mcp_servers` auto-merge into target project `.mcp.json` safely.
2. Add `skills_library/cut_rig.json` manifest + `Skill Settings` schema (`defaultEditor`, `defaultAspect`, `encoder`, `outputDir`) in `ContextRig`.
3. Write comprehensive `README.md` with quickstart (`claude mcp add`, `.mcp.json`, Windows & Linux prerequisites, KinetRig/AppRig pairing).
4. Run full `windows-latest` + `ubuntu-latest` test suite and tag `v0.1.0`.

---

## Immediate Milestone Checklist
- [x] Phase 0: Initialize `package.json`, TypeScript config, MIT `LICENSE`, CI workflow
- [x] Phase 1: `cutrig_doctor`, `cutrig_probe_media`, core FFmpeg tools + offline lavfi tests
- [x] Phase 2: Whisper captions + CapCut draft JSON adapter with `.bak` safety
- [x] Phase 3: DaVinci Resolve + Premiere/AE adapters + `SKILL.md` playbooks
- [x] Phase 4: `ContextRig` `.mcp.json` support + `cut_rig` manifest + `v0.1.0` release
