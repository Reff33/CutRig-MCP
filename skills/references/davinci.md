# DaVinci Resolve Playbook (Windows & Linux)

- **Prerequisites:** Enable external scripting in DaVinci Resolve -> *Preferences -> System -> General -> External scripting using = Local*, and keep Resolve running before calling `cutrig_resolve_action` (except `dryRun: true`).
- **Typical Sequence:**
  1. `cutrig_resolve_action` with `action: "get_status"`
  2. `action: "create_timeline"` (`timelineName`)
  3. `action: "import_media"` (`mediaPaths`)
  4. `action: "render_timeline"` (`presetName`)
- **Linux Note:** Fully supported via `/opt/resolve/Developer/Scripting/Modules`.
