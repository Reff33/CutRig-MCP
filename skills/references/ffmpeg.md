# FFmpeg & Whisper Universal Playbook (Windows & Linux)

- **Fast cuts (`cutrig_trim`):** Keep `reencode: false` for fast keyframe-aligned stream copy; set `reencode: true` when frame-accurate cut points are required.
- **Mixed audio/silent clips (`cutrig_concat`):** Silent clips (e.g. `KinetRig` renders) are auto-padded with `anullsrc` whenever mixed with audio clips.
- **Vertical social repurposing (`cutrig_reframe`):** Use `aspect: "9:16"` + `mode: "blur_pad"` for widescreen screen recordings or talking-head footage you don't want cropped tightly.
- **Voiceover + BGM (`cutrig_audio_mix`):** Default `targetLufs: -14`, `bgmVolume: 0.18`, `ducking: true` lowers music automatically under speech.
- **Captions (`cutrig_auto_captions` -> `cutrig_burn_subtitles`):** Generate `.ass` (`tiktok_bold`) for punchy short-form subtitles; use `cutrig_preview_frames` before and after burn to visually verify safe margins.
