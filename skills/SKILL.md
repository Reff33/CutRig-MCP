# CutRig MCP — AI Video Editing & Timeline Skill

Cross-platform video editing, audio/subtitle mastering, and NLE timeline automation (FFmpeg, CapCut drafts, DaVinci Resolve, Premiere Pro, After Effects).

## Core Workflow Rules
1. Always run `cutrig_doctor` first to verify OS, FFmpeg/encoders, Whisper backend, and installed NLE adapters.
2. For 2+ clips, call `cutrig_batch_analyze_clips` ONCE (parallel ffprobe + single grid contact sheet) instead of running `cutrig_probe_media` + `cutrig_preview_frames` one file at a time; use `cutrig_probe_media` only for single files.
3. Never overwrite original source files or project drafts; rely on non-destructive auto-suffixing and `.bak` backups.
4. Load only the relevant editor playbook in `references/` when working with a specific tool:
   - `references/ffmpeg.md` — Universal trim, concat/xfade, reframe, LUFS/ducking, captions, preview frames
   - `references/capcut.md` — CapCut local `draft_content.json` assembly + export handoff
   - `references/davinci.md` — DaVinci Resolve Scripting API (Windows & Linux)
   - `references/premiere.md` — Premiere Pro ExtendScript/UXP bridge (Windows/macOS)
   - `references/after-effects.md` — After Effects `aerender` headless comp renders (Windows/macOS)
5. When `KinetRig` is active in the same project, import rendered `KinetRig` MP4 openers directly onto Track 1 via `cutrig_concat` or a single batched `cutrig_capcut_insert_clips` call.

## CapCut: One-Call Rule
Every CapCut fix must be ONE `cutrig_capcut_adjust_timing` / `cutrig_capcut_color_grade` call. Never patch `draft_content.json` by hand, never write a throwaway script, never tell the user to drag clips in the GUI.

- **Text fit:** `textAutoFit: true` (scale from each block's own longest line, clamped 0.4–0.8) or `textSafeScale: 0.75`; add `textYTransform: 0.15`, `textFontSize: 5.6`.
- **Text vs transitions:** the text track renders above video, so spanning a transition is harmless — only a text **start** inside a transition window is a defect. `avoidTransitionsForTexts: true` + `textMinGapAfterTransitionSec: 0.3` shifts starts; the response's `textOverlapCount` must come back `0`. Never trim a long quote to dodge a transition.
- **Transitions:** `transitionRandomRange: { minSec: 0.4, maxSec: 1.0 }` or an explicit `transitionDurations` list.
- **CapCut open?** The tools close `CapCut.exe` and relaunch it automatically (`autoCloseCapCut` / `autoReopenCapCut` default true). Never ask the user to close it.
- **Version dialog** ("requires the latest app version"): CutRig pins `platform.app_version` / `last_modified_platform.app_version` to the installed build on every write and picks the newest `Apps/<ver>/CapCut.exe` when relaunching. If the dialog still appears, the install is older than the draft's `new_version` — update CapCut, don't downgrade the draft.
- **Verify, don't guess:** `cutrig_capcut_validate_draft` is read-only and cheap — run it on an inherited draft before editing and again afterwards. It catches dangling material refs, app_version pair mismatch, text scale overflow, and text starts inside transitions (`ok`, `errorCount`, `issues`).
- **Undo:** `cutrig_capcut_restore_backup` restores the newest `.bak` pair and re-syncs the mirrored `Timelines/<id>/draft_content.json`. Use it instead of hand-editing JSON back after a bad batch.
- **Subtitles:** `cutrig_capcut_add_text` with `srtPath` imports every cue in one call — no per-line loop.
