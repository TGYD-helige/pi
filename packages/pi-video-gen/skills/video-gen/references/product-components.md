# Product components in video

Read this guide for an existing Remotion film or an explicit request to mount React product components in Remotion. For a new release-note film, screenshots or supplied footage, follow [film direction](film-direction.md) and the default [HyperFrames path](hyperframes-handoff.md) or the user's selected assembly method.

## Trace the claim

Before mounting UI, record the requested version and the few changes worth demonstrating in the treatment:

| Viewer benefit | Release state/version | Source commit or tag | Component and demo state | Observable result and limits |
|---|---|---|---|---|
| What the viewer can do | Released, merged or development | Exact evidence | Source file plus input/result fixture | What appears on screen; what is illustrative |

Keep claims within that version/platform's evidence. Translate an update into an object, action and observable result; read the copy without its screenshot to check that it explains the benefit. Before/after comparisons need evidence of both states.

## Mount the business component

1. Identify the component that implements the operation, its CSS/theme, fonts/assets, providers and data inputs. Reuse the business view with its original styles. A shared button alone does not reproduce a product demonstration.
2. Put the editable film and the component source it consumes inside the trusted Remotion `projectDir`, outside generated output directories. For an external product, snapshot the necessary source/styles/assets there, retaining source paths, commit, license notices and local changes. Keep the product checkout unchanged. The current fingerprint covers the project tree and selected runtime versions, not arbitrary imports outside the tree or dependency contents in `node_modules`; resolve those before claiming frozen recovery. See [Remotion handoff](remotion-handoff.md).
3. Supply fixed demo data at the component's existing props/provider boundary. Keep credentials and live account data outside the demo. Reuse its theme/provider chain, scope portals into the demo container, and wait for fonts/images before capturing. Check dependency resolution uses one React runtime when preparing the project.

**Ready:** the intended business component appears with its styles and required context, and each shown state can be reproduced without a live service.

## Derive state from the frame

Prefer controlled props calculated from `useCurrentFrame()` and the composition FPS. Keep request identity and result data stable as time changes. A render may start in the middle or visit frames backwards; rebuild state from time rather than depending on previously played frames, timers, wall-clock time or unseeded randomness.

For a component that only exposes interactions, use its real input/click behavior in a project-local adapter. Reset and replay to the requested time, await the resulting UI state and make repeated seeks idempotent. A cursor graphic can illustrate an action, while a state transition or actual interaction must produce its result. Use the current-frame value for every animated layer; let important sound and picture landings share one event table.

The [component example](../examples/continuous-demo/README.md#product-component-example) mounts one `RequestWorkspace` in both an interactive playground and a frame-driven film. It is a self-contained sample product with fixed data, not Pi's interface or evidence of a shipped product feature. Replace its component, original CSS and fixtures together for an actual product. It does not install aliases or a second animation runtime.

Studio's canvas selection can intercept pointer clicks. In `ProductPlayground`, enter the request, focus the submit button and press Enter to exercise the actual form submission. Keep that preview behavior separate from the film's frame-derived fixture states.

## Verify the encoded result

Render draft, typing, pending and result states out of order, then repeat the result frame. Compare identical-time images and inspect full-size stills for correct UI, text, crop and portals. Check source imports and rendered appearance together: an import alone does not establish that the business component produced the displayed behavior.

Use `qcTimesSec` around each risky state change in the final composition. Review returned frames from the actual encoded MP4 as well as project stills. Watch the transition at normal speed when available; unchanged hashes establish reproducibility, not correctness or aesthetic acceptance. For sound, follow [film direction](film-direction.md#5-plan-sound-on-the-same-clock-as-picture).
