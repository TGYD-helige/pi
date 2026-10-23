# Motion authoring

Use this guide for precise UI, text and chart animation in an editable Remotion project. It supplements film direction; a single generated clip, straightforward assembly, supplied edit or intentional montage does not need a continuous-motion plan. No external skill or animation runtime is required.

## Make each handoff explain a change

Start with the real product evidence. Choose the object the viewer follows: a request, selection, data point or physical item. Write only the important handoffs:

| Time window | Persistent object | Before → after | Viewer focus and reading hold | Sound landing |
|---|---|---|---|---|
| 1–3s | Request composer | Compact input → expanded product workspace | Keep the entered request readable while its container grows | Expansion settles at 3s |
| 5–6s | Same request row | Submitted request → visible result | Follow the selected row; hold the result for 2s | Result becomes visible at 6s |
| 9–10s | Result mark | Product result → closing brand anchor | Keep a single focal area and enough time for the closing text | Resolve at the landing, then leave room for the tail |

These are illustrative times, not a required structure. Use a persistent object only when it clarifies causality. For a deliberate cut, record why the new view helps. Different shot lengths, pauses and speed changes should serve information rather than satisfy a numerical rhythm threshold.

## Build on a shared event clock

Record the important landing frames in one project-level object, such as `events = { expanded: 90, result: 180 }`. Derive movement start frames from those landings and the chosen movement duration. Let both the picture and audio reference those values. Changes to a landing then move the related sound with it.

Use one visible carrier across the transition, interpolating position, bounds and relevant state. Keep animation a function of the current frame; random choices must be seeded. Reuse Remotion's motion helpers. Do not reset the carrier by swapping independently animated scene trees halfway through its handoff. Camera movement should preserve the carrier and important text within the delivery frame; settle the camera before asking the viewer to read dense content. Check a vertical layout independently rather than cropping a horizontal one.

For sound, use supplied or appropriately licensed assets. Put sparse accents on meaningful results, not on every animated property. Music should leave room for speech and important effects; author gain changes in the project when needed. Word-triggered animation requires timing with a known source and precision. Sentence boundaries or interpolated estimates MUST NOT be described as measured word alignment. Missing sound assets remain a production gap, not evidence of a completed sound treatment.

## Review the vulnerable moments

For each risky handoff, choose a small set of before, middle and after timestamps. Include the moment of greatest zoom or travel, dense text and the result hold. Put up to 32 selected seconds-based times into `qcTimesSec` in the existing Remotion spec. Batch work still supplies `videoGenShotTimesSec` for every shot. The checks validate times and extract actual export frames; they do not recognize the carrier or judge aesthetics.

Inspect those returned frames for lost objects, crop, unreadable text, duplicated elements and a focus jump. Watch the actual transition at normal speed when playback inspection is available. Listen to the export when audio inspection is available. A still cannot prove temporal continuity, and a peak/loudness measurement cannot prove pleasant or intelligible sound. State unreviewed modalities explicitly.

For a revision, identify the exported version/path, timestamp, screen region and expected change. Edit the smallest relevant source section, update shared event timing, render into a new job and review both the changed window and neighboring joins. Keep the editable project, source assets and exported version together as the delivery record.
