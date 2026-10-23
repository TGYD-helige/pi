# Film direction

Use this workflow for product launch films, product demos and authored explainers. Scale the plan to the requested film: a short supplied edit can use a few lines in chat; a film with several scenes or collaborators benefits from a saved `treatment.md` beside its editable source. Keep planning/source files outside generated job directories. The selected Timeline or Remotion guide remains the authority for executable inputs, trust, paid scope and recovery.

## 1. Ground the film in the product

Read the supplied site, UI, brand assets, data and footage before designing scenes. State the audience, the one idea the viewer should retain, the target duration/aspect ratio and the evidence that demonstrates that idea. Trace on-screen claims, numbers and UI states to those materials. Label illustrative mockups as such; use actual product states for demonstrations. If access is unavailable, identify the missing evidence and work from the material available without inventing product capabilities.

Resolve only decisions that change the result and remain unspecified. Use an established style and supplied media first. State reasonable defaults for missing creative preferences and continue; ask when a missing fact or choice prevents a faithful result. Record whether sound comes from existing footage, supplied music, narration, or a music/effects treatment. Follow the entry skill's authorization rules before any paid generation or narration upload.

When visual direction is genuinely open, outline up to three directions that differ in material or motion language, explaining how each serves the product. Recommend one and proceed with that default unless the user requested a selection. For an agreed style, develop it directly. Make actual key frames for materially different directions only when they will help decide the result; respect the chosen image workflow and authorization.

**Ready to proceed:** the central claim has evidence, the material and visual direction support it, and any decision that blocks faithful production is resolved.

## 2. Choose a motion language that serves the explanation

Before choosing effects, identify what the viewer needs to understand. Record a primary motion language and why the actual material supports it:

| Viewer needs | Useful motion language | Material and acceptance |
|---|---|---|
| Follow an operation from request to result | Cursor-led demonstration or a continuous state change | Real interface, CLI output or faithful reconstruction; the operation and its result remain identifiable |
| Understand how parts work together | Mechanism animation or a system diagram | Actual components and relationships; motion shows a connection, transformation or dependency |
| See evidence or a comparison | Data-led animation or editorial annotation | Sourced values and readable comparisons; the important result gets reading time |
| Experience the range of a creative tool | One deeply developed artifact or a varied showcase with a shared visual anchor | Actual outputs or clearly labeled original studies; each passage demonstrates a different capability |
| Remember a short claim or brand | Kinetic typography, a crafted object or a generative composition | The product's own words, identity and visual material; the picture supports the claim |

Combine languages only where the change helps the message. Depth and a continuous camera are choices, not default quality upgrades. A coherent palette can support very different framing, density and movement; visual unity does not require repeating one layout.

For capability showcases, name what each passage proves. Recoloring the same object or moving the same card through several arrangements does not establish range. For product demonstrations, use the real tool/interface/output rather than an invented editor. Label workflow illustrations as illustrations and keep them distinct from evidence of shipped functionality. A persistent decorative object earns its place only when its transformations explain something; keep a shared color, cursor or framing anchor instead when the subject needs to change.

**Ready to plan:** the chosen language fits the requested film, its hero moment has suitable material, and the film would lose something meaningful if another product's name were substituted.

## 3. Design the rhythm before building every scene

Choose the route that carries the explanation: continuous movement through one world, a montage linked by a beat or visual anchor, or a continuous spine with a short montage burst. For a demo, preserve causal continuity across UI/device changes: the same request, object or person should remain identifiable through the handoff.

Write a beat map in chat or the treatment. Each row describes what changes for the viewer, with enough reading time after the movement lands:

| Time window | New information and evidence | Main reading area | Motion and landing | Reading hold | Sound cue |
|---|---|---|---|---|---|
| 0–3s | A real user problem | One short line | Reveal the problem; settle | Read before the next claim | A restrained onset, if appropriate |
| 3–11s | Actual product action that addresses it | Relevant UI region | Follow the same request into its result | Hold on the changed state | Align a cue to the result |
| 11–23s | Proof from supplied material | One result, then supporting detail | Change scale or density to emphasize the proof | Keep essential evidence readable | Build toward the key result |
| 23–30s | The takeaway and requested next action | Product/brand and closing line | Resolve into a stable end frame | Read the closing line | Resolve rather than cut off |

This is an example, not a fixed structure or timing requirement. Give each shot a verb that explains something: connect, filter, compare, reveal, assemble. Vary speed, scale, density and stillness to serve the message. For an energetic launch, consider an early hook, a denser passage and a contrasting pause before the hero moment. A quiet explainer can use a different curve. A planned reading hold is useful; repeated motion that adds no information is a revision candidate.

Before filling every beat, describe the energy of each stretch and what changes between them: shot scale, movement speed, camera behavior, information density or musical texture. For an energetic launch or showcase, start with a strong subject already visible and an early meaningful action, build to a visibly denser passage, then leave space for the hero result and ending. A continuous demonstration can vary detail, scale and reading time without cuts. A hybrid film can insert a short, readable burst of different materials around a stable anchor. Choose the route from the brief; a fixed cut count or one-take rule is not an acceptance criterion.

Review the proposed curve for repeated grammar: several seconds of gentle enlargement, a hold, then a shrink, repeated throughout, remains flat even when the total duration or scene count increases. Replace repetition with a change that communicates new information. In a planned burst, keep the focal area trackable and align intentional cut hits to the actual music grid; allow explanatory passages to breathe. Do not label a background loop with timed accents a complete musical arc unless its sections actually change with the film.

Choose the typography and palette from the actual brand, product or source material. Keep numbers and essential text editable and render exact UI, charts and text through Timeline overlays or Remotion as appropriate. Use movement to bring the eye to a reading area, let it settle, then allow the state change or reading hold. Check the transition between scenes at normal speed, especially when the viewer must follow something across screens.

For continuous or hybrid films, read [motion authoring](motion-authoring.md). For each important handoff, name the on-screen object that persists, its state before and after, and the time the viewer should recognize the result. “Fade into the next card” is insufficient when the explanation depends on following the same request or object. A deliberate montage cut remains valid; record its purpose rather than inventing a continuity link. Do not force a continuous camera onto supplied footage or a story that benefits from cuts.

**Ready to build:** every scene adds identifiable information, every essential claim has a readable landing/hold, and the film's pace supports the intended tone.

## 4. Prove the hardest moment, then assemble

Build the shot or transition most likely to fail first: a dense UI view, cross-device handoff, difficult chart, or hero reveal. Inspect it at delivery resolution using the Remotion project's native preview/still renderer, or source-frame and overlay stills for Timeline, before extending the same treatment to the full film. Correct unreadable text, collisions, unclear focus and broken continuity at this stage. Reserve `video_compose` or `video_render` for one complete initial film export after all scenes are ready; a full-length placeholder film is not a required proof stage. If a separate prototype video is genuinely necessary, explain that extra render explicitly rather than silently adding it to the default workflow.

For a multi-scene film, inspect representative key frames for the opening, hero moment, densest information and ending. These may be frames from the same prototype rather than separate generated images. For missing mascot portraits or shot frames, use `image_generate` through the pi-image-gen skill and record the returned asset paths. Keep supplied screenshots as original assets. Then build the remaining scenes using the chosen Timeline or Remotion path and any generated shots the film actually needs.

## 5. Plan sound on the same clock as picture

For each important sound cue, record the event and landing time or frame. Put a click on the click, a hit on the actual landing, and a reveal cue on the reveal; the start of a tween is not necessarily its landing. Use a shared beat grid when the edit is music-driven. After changing timing, update the affected picture and sound cues together.

Use existing or appropriately licensed audio first. For narration-led films, keep speech intelligible and give important words space. If word-level timing is available, record its source and precision before anchoring a visual to it. Sentence timestamps and interpolated word estimates MUST NOT be described as verified word alignment.

Choose the musical character from the product and visual direction before choosing instruments: for example, interlocking acoustic pulses for a systems explanation, a restrained electronic groove for a technical launch, or a warm small ensemble for a human story. These are options, not genre defaults. Describe the opening, build, peak and resolution in the treatment, including changes in instrumentation, density and silence. Reuse the film's motif at the important reveal or brand ending. A local synthesizer is one implementation option; prefer suitable existing audio when it better serves the intended sound. Additional oscillators, a louder master or more accents alone do not demonstrate better composition.

Implement only what the selected path supports:

- **Timeline** supports BGM, per-segment narration, source audio and sentence-timed subtitles when Edge TTS supplies boundaries. Its BGM uses a fixed mix level; it does not dynamically duck under speech or accept arbitrary timed sound-effect/word-cue fields. Keep its input to the documented schema.
- **Remotion** can place existing audio assets and animate against frame/time values in the editable project. Author sound timing and volume changes there when the film needs them, following the Remotion handoff. Generated media is still handed off through the existing asset mechanism.
- A sound plan alone creates no audio. If suitable audio or the means to produce the requested treatment is missing, state that gap and resolve the choice with the user. Promise local composition or word alignment only after an available implementation has been verified.

## 6. Review the exported film and handle revisions

Review the actual final export against the claim and beat map, not just the source preview or a successful render result. Use the existing QC artifacts and tools available in the environment; an additional QA command is not assumed to exist.

1. **Stills:** inspect the key moments at delivery resolution for accurate UI/data/text, readable type, crop, overlap, contrast and a clear focal area. Check frames immediately after scene changes as well as settled frames; an early flash can disappear before a segment's midpoint.
   For Remotion, put selected handoff times into the spec's `qcTimesSec`: include before, during and after a risky transition, not only its attractive final state. Check the carrier and essential text remain in frame. The returned report binds these samples to the actual exported file's SHA-256; it does not measure semantic continuity.
2. **Motion:** watch the full export at normal speed when playback inspection is available. Check whether a viewer can follow causal changes, read each essential state, and feel the intended pace. Record timestamped problems, including unintended flashes, idle stretches and abrupt joins. Planned holds and cuts need judgment rather than automatic rejection.
3. **Audio:** listen when audio inspection is available. Check voice clarity, cue synchronization, balance, clipping and the ending. Waveforms, spectra and loudness measurements are supporting evidence; they do not establish that the music sounds good or speech is intelligible.
4. **Delivery:** report the exact exported path/version, what passed visual/motion/audio review, any unreviewed modality, and accepted limitations. A render/QC pass MUST NOT be presented as aesthetic or user acceptance. Preserve the editable source and asset references with the deliverable.

When playback or listening is unavailable, inspect the frames and timing/audio evidence that are available, identify the remaining viewing/listening check, and report the export with that limitation. Do not claim a normal-speed watch or listening pass that did not happen.

Before presenting an initial creative film, write up to three concrete director's notes against the actual version: its weakest opening/hero choice, a passage whose material or movement adds little, and a pacing, typography or sound problem. Give the timestamp and intended improvement, then address the supported findings. Use fewer notes when fewer real issues exist; do not manufacture defects or numeric scores. A low-information passage needs a content or direction decision rather than simply more movement. Check that the main claim survives muted playback at the intended screen size. Report any unresolved issue or unreviewed modality honestly; technical QC alone does not close these notes.

For feedback, bind the request to an exact exported version/path (and hash when available), timestamp, screenshot or screen location, and expected change. Inspect that moment before editing; ask only when the intended change cannot be inferred. Make the smallest relevant source change, update affected timing, and create a new job for revised inputs under the existing immutable-job rules. Review the target window, its neighboring joins and any shifted downstream cues; deliver the new version with a concrete account of what changed.
