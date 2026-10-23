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

`timing.mjs` owns camera poses and important landing times. The composition interpolates those poses from the current frame; `prepare-audio.mjs` reads the same events for its original stereo score. The score uses synthesized pads, bass, arpeggios, percussion, transition air and landing accents, with music reduced around accents. There is no speech track or claim of verified word alignment. Timeline and review UI are illustrative; the plugin's actual returned QC report is the delivery evidence.

## Prepare and preview

Copy this directory into a trusted project outside the configured video output directory. In the copy run `npm install --package-lock=false`, then `npm run prepare-audio`. This creates `public/score.wav` locally and checks the event order, finite audio samples, peak range and quiet endpoints. The generated score is excluded from Git. No external sound samples are downloaded. Dependencies are pinned; Remotion's own license terms apply.

Run `npm run studio` for the editable preview. Dependencies and the installed Chrome/Chromium browser are project preparation; the plugin does not install them during a tool call.

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
