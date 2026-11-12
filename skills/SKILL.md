# CutRig MCP — AI Video Editing & Timeline Skill

Cross-platform video editing, audio/subtitle mastering, and NLE timeline automation (FFmpeg, CapCut drafts, DaVinci Resolve, Premiere Pro, After Effects).

## Core Workflow Rules
1. Always run `cutrig_doctor` first to verify OS, FFmpeg/encoders, Whisper backend, and installed NLE adapters.
2. Probe every clip with `cutrig_probe_media` before cutting, reframing, or concatenating.
3. Never overwrite original source files or project drafts; rely on non-destructive auto-suffixing and `.bak` backups.
4. Load only the relevant editor playbook in `references/` when working with a specific tool:
   - `references/ffmpeg.md` — Universal trim, concat/xfade, reframe, LUFS/ducking, captions, preview frames
   - `references/capcut.md` — CapCut local `draft_content.json` assembly + export handoff
   - `references/davinci.md` — DaVinci Resolve Scripting API (Windows & Linux)
   - `references/premiere.md` — Premiere Pro ExtendScript/UXP bridge (Windows/macOS)
   - `references/after-effects.md` — After Effects `aerender` headless comp renders (Windows/macOS)
5. When `KinetRig` is active in the same project, import rendered `KinetRig` MP4 openers directly onto Track 1 via `cutrig_concat` or `cutrig_capcut_insert_clips`.
