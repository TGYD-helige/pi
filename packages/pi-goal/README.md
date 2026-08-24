# @amaster.ai/pi-goal

![pi-goal preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-goal/preview.png)

A Pi extension that lets Pi **keep working until a goal is met**. You don't have to write the completion condition yourself — run `/goal` with no argument and the extension derives a measurable condition from the conversation, shows it to you for a quick confirmation, then keeps the agent working (re-checking after each run) until the condition holds.

Modeled on Claude Code's stop-condition mechanism, with a token/iteration budget backstop borrowed from Codex's goal mode.

## How it works

1. **Set a goal.** Either give an explicit condition (`/goal all tests pass and lint is clean`) or let the extension derive one from the conversation (`/goal` with no argument).
2. **Derived goals are confirmed** in interactive (TUI) mode before they start, so a mis-derived goal can't run off on its own. Non-interactive modes skip the confirmation.
3. **After each agent run** (`agent_end`), a small evaluator model judges whether the condition is met:
   - **Met** → the goal is marked achieved and cleared. Pi stops.
   - **Not yet** → Pi is nudged to continue, told what still remains.
   - **Impossible** → Pi stops and tells you why.
4. **Backstops.** Continuation stops after `maxIterations` rounds or once an optional `tokenBudget` is exceeded, so a bad goal can't loop forever.

Goal state is session-scoped and held in memory (no cross-session persistence), matching Claude Code's behavior.

## Pi lifecycle (how the engine hooks in)

The goal engine is driven by Pi's lifecycle events. For one `pi -p '<prompt>'` run (non-interactive), events fire in this order:

```
session_start                                 ← session-level, once
  │   pi-goal: load config, read the --goal flag
  ▼
[ per user prompt — the "agent-level" block below repeats ]
  │
  before_agent_start  { prompt, systemPrompt } ← carries the user's input for this turn, once per prompt
  │
  agent_start         { }
  │
  ├─ [ per turn, may repeat ]
  │    turn_start       { turnIndex }
  │    message_start    { message (user) }
  │    message_end      { message (user) }
  │    message_start    { message (assistant) }
  │    message_end      { message (assistant) }
  │    turn_end         { turnIndex, message, toolResults }
  │
  agent_end           { messages: [...] }       ← engine evaluates + stops/continues, once per prompt
  │   If a goal is active: build a transcript from `messages`, ask the
  │   evaluator ok / impossible / not-yet. Not-yet → sendUserMessage(continue)
  │   → triggers a new agent run (back to before_agent_start).
  │
  agent_settled       { }                        ← this prompt is fully done
  ▼
[ interactive: wait for next input · print mode: process exits here ]

session_shutdown                               ← on exit/switch; pi-goal clears state
```

Events pi-goal uses:

| Event | What pi-goal does | Notes |
|-------|-------------------|-------|
| `session_start` | Load config; read the `--goal` flag | Session-level, fires once |
| `before_agent_start` | If a `--goal` derivation is pending, derive the condition from `event.prompt` (this turn's user input), then set the goal | Fires once per prompt; the right anchor for auto-derivation since no transcript exists yet at `session_start` |
| `agent_end` | If a goal is active, run the engine on `event.messages`: evaluate → mark achieved/impossible or `sendUserMessage` to continue | Engine core. `event.messages` is the full conversation, so no separate buffering is needed |
| `session_shutdown` | Clear the goal | Cleanup |

The interactive `/goal` command (no argument) derives from the session's own history, read via `ctx.sessionManager` — not a buffer this extension maintains.

Note on derivation timing: a condition can only be derived once there is conversation to derive from. `session_start` is too early (no transcript yet); `before_agent_start` is the first point that carries the user's prompt for the turn, so auto-derivation keys off it rather than firing at startup.

## Usage

```
/goal <condition>   Set an explicit completion condition.
/goal               No active goal → derive one from the conversation (with confirmation).
                    Active goal → show its status.
/goal clear         Clear the active goal (also: stop, off, reset, none, cancel).
```

The slash command is for interactive (TUI) use; print mode can't dispatch it. For the CLI / non-interactive runs, use the `--goal` flag instead:

```
pi --goal '<condition>' -p '<prompt>'   Set an explicit goal, then run the prompt.
pi --goal '' -p '<prompt>'              Derive the goal from the prompt (at before_agent_start).
```

## Configuration

Settings key: `pi-goal` (in `~/.pi/agent/settings.json`, agent dir, or project `.pi/settings.json`). Project settings are loaded only after project trust is accepted. Environment-variable interpolation is available in user and agent settings, but not in project settings.

```json
{
  "pi-goal": {
    "model": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "maxIterations": 10,
    "tokenBudget": 200000,
    "transcriptMaxChars": 8000,
    "requireConfirmForDerived": true
  }
}
```

| Key | Default | Purpose |
|-----|---------|---------|
| `model` | — | Provider/model for deriving and evaluating conditions. **Omit to disable the automatic engine** — `/goal <condition>` still sets a goal, but nothing auto-derives or auto-continues. |
| `maxIterations` | `10` | Max continuation rounds before Pi stops pushing. |
| `tokenBudget` | — | Optional hard token ceiling; the goal is paused (`budget_limited`) once exceeded. |
| `transcriptMaxChars` | `8000` | Max transcript chars fed to derive/evaluate. |
| `requireConfirmForDerived` | `true` | Ask before starting a derived goal (TUI only). |

Prefer a small, cheap model for `model` — the evaluator runs after every agent run.

## Relationship to Claude Code / Codex

- **Engine (from Claude Code):** goal = a stop condition; Pi keeps going until an evaluator judges it met. Passive — it drives continuation off `agent_end`, not a background scheduler.
- **Prompts (from Claude Code):** the evaluator and activation prompts are adapted almost verbatim from Claude Code's own stop-hook prompts — including the quote-the-evidence requirement, the "insufficient evidence in transcript" fallback, the impossible-judgment discipline (the assistant's claim is *evidence, not proof*), and the truncated-transcript note.
- **Auto-derivation:** you don't have to phrase the condition; it's inferred and confirmed. (No CC analogue — CC always takes an explicit condition.)
- **Budget backstop (from Codex):** token + iteration limits prevent runaway loops.
- **Not included:** Codex's idle auto-resume, pause/resume dialogs, file-backed objectives, and cross-session persistence.
