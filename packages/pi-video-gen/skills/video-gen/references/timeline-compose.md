# Timeline composition

Use for promos/explainers from still images and existing clips. Media rendering is local and uses no paid video model. If narration is requested, disclose that the explicit `edge-tts:<voice>` option sends narration text to Microsoft before using it.

1. **Collect existing images/screenshots/clips first**, and use `image_generate` for missing or explicitly requested replacement visuals. Keep all source media outside the job directory, then author `<jobDir>/timeline-input.json`. `assets/`, `overlays/`, `audio/`, `segments/`, `qc/`, generated tracks, subtitles, and `final_video.mp4` are reserved pipeline outputs; a fresh job refuses any conflicts rather than deleting them.
   ```jsonc
   {
     "title": "产品宣传片",
     "output": { "resolution": "1920x1080", "fps": 25, "codec": "h264" },
     "voice": "edge-tts:zh-CN-YunyangNeural",   // explicit opt-in: narration text is sent to Microsoft
     "ttsFailureMode": "fail",                  // or "silent-subtitles" only after the user accepts that degradation
     "subtitles": { "mode": "burn", "fontSize": 36,
       "textColor": "#ffffff", "backgroundColor": "#000000", "backgroundOpacity": 0.55 },
     "segments": [
       {
         "id": "intro",
         "image": "/abs/frame-1.png",
         "durationSec": 5,                      // image only: may be "auto" from narration
         "motion": "kenburns-in",               // image only
         "transitionTo": { "type": "xfade", "style": "fade", "durationSec": 0.8 },
         "overlay": { "title": "标题", "subtitle": "副标题", "position": "bottom-left" },
         "narration": "这一段的中文旁白文本"
       },
       {
         "id": "demo",
         "video": "/abs/demo.mp4",
         "trimStartSec": 2.5,
         "durationSec": 6,                      // video always uses a numeric duration
         "fit": "contain",                      // contain | cover
         "sourceAudio": { "muted": false, "volume": 0.25 }
       }
     ]
   }
   ```
2. **Chinese text NEVER comes from an image model** — titles/subtitles go in `overlay` and are rendered locally via SVG (no garbled CJK).
3. **Paid-model confirmation is unnecessary** for the local media render, but still show the segment count and total planned duration before calling `video_compose`. Obtain explicit agreement before sending narration text to Edge TTS.
4. Every segment contains exactly one of `image` or `video`. Video segments are normalized to the output resolution/fps, may be trimmed/scaled, and mix their source audio with narration before optional BGM. Video source audio without a stream degrades to silence; `sourceAudio.muted: true` or `volume: 0` disables it. A video's numeric `durationSec` is its fixed trim window; narration that does not fit is rejected instead of extending it.
5. Narration uses Edge TTS only with an explicit `edge-tts:<voice>` selection; its text is sent to Microsoft. Measured audio duration drives image `durationSec: "auto"`; subtitles use each segment's actual video timing. `subtitles.mode` defaults to `"soft"` (`mov_text`); `"burn"` renders the configured font/color/background directly into each narrated segment. TTS failures stop the job by default. Use `ttsFailureMode: "silent-subtitles"` only as an explicit degradation choice; it keeps the subtitle track and fills that segment with silence. Once accepted, that degradation is cached for the immutable job; create a NEW job to retry real narration.
6. On completion, review the QC frames in `<jobDir>/qc/` yourself (Read the PNGs) before showing the result — flipped/overlapping text only shows up visually. Soft `mov_text` subtitles are not burned into those PNGs; the pipeline separately verifies that the subtitle stream exists and that the SRT cues match the resolved segment timeline.
7. The spec is immutable per job: rerunning the same path resumes only regular job-local artifacts whose manifest hashes still match; changes require a NEW job directory. A committed artifact that is missing or changed is rejected rather than regenerated underneath cached downstream outputs. A completed manifest with any missing artifact hash is rejected; an interrupted manifest invalidates unverified downstream hashes before rebuilding an uncommitted upstream artifact.
