# CapCut Draft Playbook

- **Location:** On Windows, drafts live at `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`. On Linux, pass a custom `draftsDir` to prepare portable drafts.
- **Safe Mutation:** Every `cutrig_capcut_insert_clips` and `cutrig_capcut_add_text` call writes `.bak` snapshots of `draft_content.json` and `draft_meta_info.json` first.
- **Workflow:**
  1. `cutrig_capcut_create_draft` (e.g. `1080x1920`, `30` fps for Reels/TikTok).
  2. `cutrig_detect_beats` on project MP3/WAV (or `cutrig_capcut_list_audio` to browse already-cached CapCut `Cache/music/*.mp3` + `.beat` timestamps) before cutting clips on-beat.
  3. `cutrig_capcut_insert_clips` to place `KinetRig` opener + A-roll + BGM track aligned to beat timestamps.
  4. `cutrig_capcut_add_text` for timed hook titles or SRT-derived captions.
- **Export Fallback:** CapCut Desktop has no official headless CLI export. Open the draft in CapCut and press `Ctrl+E` (or hand off to optional `AppRig` Desktop MCP if UI automation is enabled).
