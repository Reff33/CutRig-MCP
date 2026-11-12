# Adobe Premiere Pro Playbook (Windows / macOS)

- **OS Guard:** Automatically skips on Linux and suggests FFmpeg or DaVinci Resolve fallback.
- **Tool (`cutrig_adobe_premiere`):** Generates sandboxed ExtendScript `.jsx` for `import_media`, `add_marker`, `apply_mogrt`, and `export_sequence`.
- **Execution:** Run the generated `.jsx` via an active UXP / `adobe-mcp` bridge or VS Code ExtendScript Debugger.
- **Shortcuts for Optional `AppRig` Fallback:** `Ctrl+I` (Import), `M` (Add Marker), `Ctrl+M` (Export Media).
