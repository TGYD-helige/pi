# Continuous motion film

An original 26-second, 1920×1080 Remotion film about pi-video-gen's creation workflow. The same preview object moves from a spatial material collection into a full-frame shot, onto an editing timeline, through separated picture/text/audio planes, into a review view and finally a play mark. This is an authored workflow illustration, not a recording of an editor supplied by the plugin. Geometric footage is rendered by code, with no upstream skill, remote media or paid model call.

## Editing units and timing

| Time | Viewer follows | Information | Sound |
|---|---|---|---|
| 0–3s | Blue moving preview | An idea becomes a shot | Opening pulse and restrained arpeggio |
| 3–6.2s | Same preview among collected materials | Materials become a sequence | Gathering accent at 4.2s |
| 6.2–10.2s | Preview grows to fill the screen | One object carries into the next view | Short anticipation pause, landing at 7.6s |
| 10.2–14s | Same picture moves onto the timeline | Picture, sound and text share time | Timeline landing at 11s |
| 14–18s | Picture and its lower planes separate | Different layers share event timing | Layer accent at 14.8s |
| 18–22s | Picture and its review strip | Hashes, handoff frames and editable source | Review landing at 18.5s |
| 22–26s | Preview contracts into the play mark | Resolve into the product name | Closing accent at 22.8s and a decaying tail |

`timing.mjs` owns camera poses and important landing times. The composition interpolates those poses from the current frame; `prepare-audio.mjs` reads the same events for its original stereo music and effects stems. The music uses synthesized pads, bass, arpeggios and percussion; the effects include transition air and landing accents. Music is reduced around accents. There is no speech track or claim of verified word alignment. Timeline and review UI are illustrative; the plugin's actual returned QC report is the delivery evidence.

## Prepare and preview

Copy this directory into a trusted project outside the configured video output directory. In the copy run `npm install --package-lock=false`, then `npm run prepare-audio`. This creates `public/music.wav`, `effects.wav`, a reference `score.wav` and `audio-report.json`. The script checks the event order, finite audio samples, sample-peak range and quiet endpoints. Generated files are excluded from Git. No external sound samples are downloaded. Dependencies are pinned; Remotion's own license terms apply.

Run `npm run studio` for the editable preview. Dependencies and the installed Chrome/Chromium browser are project preparation; the plugin does not install them during a tool call.

The two stems share a normalization gain so their sum reconstructs the reference mix within PCM rounding. The synthesized effect's absolute sample peak is measured once; each cue starts early enough to put that peak on its event landing, retaining its lead-in. `audio-report.json` records cue start/peak times, WAV hashes and sample-peak dBFS. This is a signal measurement, not a perceived-sync, LUFS, true-peak or listening pass. The film plays the two stems, not the reference mix. Adjust `inputProps.musicVolume` or `inputProps.effectsVolume` independently (defaults: 1); after changing either, measure/listen to the new encoded mix again. The reference report describes the default mix only.

## Product component example

`ProductDemo` is a silent 8-second, 1280×720 composition. It imports `product/RequestWorkspace.tsx` and its original `workspace.css`, deriving draft, typing, running and result props from `product/fixture.mjs`. `ProductPlayground` mounts the same component with normal input/submit handlers in Studio; enter text and submit to show the fixed result. The component is a sample product, not Pi's UI. Its result is a local fixture, not an AI response or live service.

| Evidence | Source | State/limits |
|---|---|---|
| Business view and original CSS | `product/RequestWorkspace.tsx`, `product/workspace.css` | Shared by film and interactive playground |
| Request/result | `product/fixture.mjs` | Fixed sample data; no release-status or real-product claims |
| Frame adaptation | `src/product-demo.tsx` | Pure time-derived props; no timers or previous-frame state |

After preparing dependencies, run `npm run verify-product -- /absolute/path/to/new-review-dir /absolute/path/to/chrome`. The output directory must not already exist. This renders four states out of order and repeats the result frame, asserting distinct states and identical repeated PNG bytes. Inspect its stills and `seek-report.json`; these checks establish frame reproducibility, not correct interaction or motion. Use `ProductPlayground` to test input/submit separately. For another product, replace the source component, CSS, providers and fixture adapter together using [product component integration](../../references/product-components.md).

To obtain MP4 evidence through the plugin, use a new job with `compositionId: "ProductDemo"` and `qcTimesSec: [0, 1.5, 2.95, 3, 3.2, 4.45, 4.5, 5]`. Inspect the returned encoded frames for the pending/result changes and watch the transition when possible. This fixture intentionally has no audio; use `ContinuousDemo` for the separate sound example.

## Render through pi-video-gen

Create `<configured-outputDir>/continuous-v3/remotion-input.json`, replacing `projectDir` with the copy's absolute path. Provide `browserExecutable` if the environment requires an explicit installed browser path.

```json
{
  "projectDir": "/absolute/path/to/copied-continuous-demo",
  "compositionId": "ContinuousDemo",
  "qcTimesSec": [0, 2.5, 3.4, 4.2, 6.2, 6.9, 7.6, 9.5, 10.2, 11, 13.6, 14.2, 14.8, 16, 17.5, 18.5, 19.7, 21.2, 22, 22.8, 24.5]
}
```

Call `video_compose` with the spec path or run `/video-gen compose <spec-path>`. Inspect the MP4 and returned QC report/frames; check the joins at 6.2–7.6s, 9.5–11s and 21.2–22.8s at normal speed, and listen to the actual mix. After source or timing changes, render in a new job directory. A successful render or a peak check does not establish aesthetic acceptance.
