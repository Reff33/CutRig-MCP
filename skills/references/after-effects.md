# Adobe After Effects Playbook (Windows / macOS)

- **Headless Rendering (`cutrig_ae_render`):** Invokes `aerender.exe` directly with `-project`, `-comp`, and `-output` using non-destructive output path checks.
- **OS Guard:** Unavailable on Linux; route motion-graphic renders to `KinetRig` (HTML5/GSAP headless Chromium -> FFmpeg) when running on Linux.
- **Best Practice:** Always test with `dryRun: true` first to verify exact `aerender` arguments and output path collision handling.
