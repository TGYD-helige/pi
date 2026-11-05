# Tool error classification

Tool failures must tell the model what is known without repeating raw provider errors. `@amaster.ai/pi-shared` supplies `classifyError`, `describeToolError`, `SafeToolError`, and `ValidationError`. They preserve `timeout`, `cancelled`, `http_error`, `network_error`, `request_failed`, `configuration_error`, `invalid_request`, or `invalid_response`, plus a validated numeric `httpStatus` when available. Unknown errors use `request_failed` instead of being blamed on credentials or configuration. The classifier inspects at most four cause levels and a bounded message prefix; it never returns raw names, messages, causes, response bodies, URLs, or credentials.

`SafeToolError` keeps classification when a lower layer replaces an untrusted exception with a curated message. It discards the raw cause. Model-facing tool failures retain `isError: true`, their existing `error` string, and additive classification metadata. Existing validation messages and curated image/video guidance remain available. Caller cancellation is propagated by the generic tool boundaries; media operations retain their existing cancellation and paid-task recovery contracts.

## Covered tool families

| Package | Error boundaries addressed |
| --- | --- |
| pi-web-access | All four tools and three existing commands; Cloudflare request/body deadlines, DeepSeek network wrapping, Kimi elapsed budget. |
| pi-browser-use | Dynamic MCP tools, vision failures, browser session control, local session transport, session HTTP relay, management requests and startup/cleanup deadlines. |
| pi-computer-use | Dynamic driver tools, connection/discovery, screenshot/vision exceptions, and transport failures. |
| pi-memory-mem0 | Active memory operations, self-hosted request/body timeouts and HTTP failures; caller cancellation. |
| pi-memory | All four file-backed tools; unreadable files fail instead of being treated as empty memory. |
| pi-task-scheduler | All six tools, schedule validation separated from storage I/O, persisted run failures and failure hooks. |
| pi-teamwork | Provider operations, initialization/execution deadlines and status command; caller cancellation. |
| pi-channels | Sending, initialization failures, model-visible failed-send status and safe delivery diagnostics. |
| pi-image-gen | Curated HTTP/network/download failures retain classification; timed-out downloads are identified explicitly. |
| pi-video-gen | All provider adapters retain transport classifications; ambiguous paid submits remain ambiguous; polling/download timeouts, job results and logs retain classification. |

Packages that do not register tools were inspected for tool registration and are outside this change. Raw upstream MCP error result content is still governed by each bridge's existing output contract; this change classifies thrown exceptions rather than rewriting every remote application's domain errors.

## Recovery semantics

A deadline is not proof of invalid configuration, a disconnected browser, an unsuccessful write, or a missing remote task. Send, mutation, and automation failures must tell the model to inspect current state before retrying. Video submit failures retain `AmbiguousSubmitError` and the existing paid-task handles/idempotency recovery path. A download failure must resume the saved job rather than recommend another paid generation.

Tests cover real web request deadlines, MCP timeout codes, nested transport causes, HTTP statuses, cancellation, safe logging, failed writes, paid-submit ambiguity, browser session control and unreadable memory files. Live services and platform-specific desktop drivers require separate validation.

## Configuration, persistence, and background failures

Malformed or unreadable settings now stop configuration loading rather than substituting defaults. Missing files still mean no configuration. Channel configuration updates refuse to overwrite an unreadable, malformed, or non-object settings file. Curated provider configuration and input validation failures retain their exact safe remediation. `ValidationError` must only contain locally constructed, vetted messages.

JSON stores recover from a valid backup with a diagnostic. If the primary is corrupt and the backup cannot be read or parsed, reads fail and no empty state is initialized. This applies to storage and scheduler JSON helpers. Conversation history rejects invalid or unsupported schemas before any write. Memory consolidation checkpoints similarly default only on `ENOENT`; corrupt, invalid, or unreadable checkpoints are not reset. Scheduler startup failures release timers and the lock, and surface safe diagnostics.

Mem0 transport errors remain distinct from invalid JSON; DNS failures remain distinct from destination-policy rejection; Ark response-body failures retain both their category and paid-submit ambiguity. Multica initialization refuses failed configuration or login commands. A failed daemon start is accepted only when a separate status command confirms `running: true`; probe failures are not automatically treated as a missing installation. Initialization failures remain available to waiting tools.

A failed memory recall supplies a bounded unavailable notice rather than implying an empty search. Failed embedded warmup does not mark session recall as complete. Background memory extraction logs safe categories and warns once per continuous failure, including authentication failures and errors recorded in an Agent result. Extraction and consolidation also detect failed memory tool results after a normally completed assistant turn. Failed consolidation leaves its checkpoint unchanged and surfaces the failure. Neither path automatically replays memory mutations with an unknown outcome.

Goal completion/evaluation keeps its existing nullable fallback. The optional `onError` callback on `completeOnce`, `EvaluateOptions`, and `DeriveOptions` carries safe diagnostics. The extension displays evaluator failures while leaving the goal active and avoiding automatic continuation or false completion. Missing or unreadable referenced files appear as per-attachment notices, so usable attachments can still be processed without silently implying that every source was inspected.
