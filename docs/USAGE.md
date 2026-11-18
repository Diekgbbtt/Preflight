# Using Prompt Preflight

This guide describes the active panel after PRs #51 and #52. The [architecture guide](ARCHITECTURE.md) distinguishes the merged control-plane components from pending panel integration.

## Install and open

Use Node.js 20 or newer, npm, and VS Code 1.90 or newer. From the repository root:

```sh
npm ci
npm run build
npm run package
code --install-extension extension/prompt-preflight-0.1.0.vsix
```

Reload VS Code if prompted. Open the Prompt Preflight activity-bar view or run **Prompt Preflight: Open** from the Command Palette. The shortcut is Cmd+Alt+P on macOS and Ctrl+Alt+P elsewhere. You can also select editor text and run **Prompt Preflight: Check Selected Text**.

Rule checks work without Claude Code. Model reviews and terminal sending require an installed Claude Code CLI and an authenticated account with access to the selected model. Set `promptPreflight.claudePath` if VS Code cannot find the executable. CLI authentication, model availability and account charges are managed outside this extension.

## Write, review and send

1. Name the target, concrete action, scope and expected result. For example: “In core/src/review.ts, add a test for malformed JSON. The test should assert that parsing throws; leave valid-response behavior unchanged.”
2. Local rules highlight missing targets, vague actions, broad scope, unclear references, missing success criteria, placeholders, risks and possible secrets. Notes and questions settle after a short pause (300 ms by default); no model is called.
3. The top status and Target/Action/Scope/Done checklist summarize these local checks. There is no automatic numeric model score.
4. **Enhance** explicitly requests a model review and then a separate improved prompt when the review identifies questions. Unknown details remain `[placeholders]`. **Use this prompt** applies the suggestion; the draft otherwise stays unchanged.
5. **Send** or Cmd/Ctrl+Enter starts a fresh Claude Code terminal process, or copies the exact draft. Send never starts model feedback. **Copy** copies directly without a study event.

Send has no confirmation by default. With `gateSending` enabled, local warnings ask for confirmation. An absent model score never triggers a model request. Text changed while a confirmation is open is not sent as the previously approved draft. Empty prompts are ignored. The extension has no skip or trivial execution mode.

The separately installed hook retains its opt-in symbolic gate, skip marker and trivial classification. It cannot read VS Code settings.

## Settings

All settings below have the `promptPreflight.` prefix.

| Setting | Default | Effect |
|---|---|---|
| `claudePath` | `claude` | CLI executable; review execution uses it directly, terminal sending launches it directly with argument arrays |
| `provider` | `claude` | Review provider; Codex inference is not implemented |
| `model` | `sonnet` | Fallback when a mode-specific model is empty |
| `thinkingEffort` | `medium` | Passed through to the Claude CLI |
| `context.includeCode` | `prompt-files` | Policy for new context consumers after consent; the current panel does not yet attach this code context |
| `quickModel` | `haiku` | Quick-review model |
| `deepModel` | `sonnet` | Detailed-review model |
| `quickReviewOnPause` | `false` | Deprecated and ignored; existing opt-ins cannot trigger model calls |
| `feedbackPauseMs` | `300` | Pause before local advice updates; minimum 100 ms |
| `gateSending` | `false` | Confirm when local warnings remain; never runs a model |
| `scoreThreshold` | `65` | Compatibility threshold for an explicitly supplied model score; ordinary local checks have no numeric score |
| `sendTo` | `terminal` | `terminal` or `clipboard` |
| `studyLog.enabled` | `false` | Record send events locally |
| `studyLog.participantId` | empty string | Participant label in each event |

To use local checks without automatic model calls:

```json
{
  "promptPreflight.quickReviewOnPause": false,
  "promptPreflight.sendTo": "clipboard"
}
```

Enhance calls the model only when requested. Clipboard mode is useful for other agents and shells: terminal sending launches the executable directly and has no direct integration with Claude Code or Codex chat inputs.

## Data and logging

Rules run locally. A model review sends the draft, rule messages, top-level workspace entry names and up to eight recently changed file names through the Claude CLI. The active panel does not explicitly attach file contents or session transcripts. The separate context assembler, redaction, canonical file resolver and session readers have merged, but their panel integration is pending. The CLI receives `--tools ""`, `--setting-sources ""` and a custom system prompt; canonical instruction-file isolation is a planned improvement, not a verified privacy guarantee.

Secret detection reports findings but does not redact the draft or prevent an automatic or requested review from receiving it. Do not treat it as a privacy boundary. See [the improvement plan](IMPROVEMENTS.md#privacy-before-context-expansion).

When logging is enabled, the exact sent draft goes to `sends.jsonl`. Linked study events go to `study-events-v2.jsonl` under VS Code extension global storage. Score/review events contain metadata and usage, with no repeated draft. First/final scores are completed model scores or null. A send without a review has no invented score/review observation. Copy alone produces no event.

Terminal sends assign an explicit Claude session ID. When that process closes, the exact session transcript supplies separate agent input, output, cache-read and cache-creation counters. Streaming snapshots with the same message ID count once. Context-size estimates are never used as execution consumption. Cost is null unless the transcript explicitly reports it. Clipboard sends cannot automatically identify an agent session. Missing transcripts produce an unavailable observation. Closing VS Code before the terminal finishes can prevent collection; restart recovery is not implemented.

The old `study-log.jsonl` remains untouched. Its send events migrate once by deterministic line ID into the v2 log; symbolic scores are retained only as `legacyRuleScore`, never as first/final model scores. Run **Prompt Preflight: Open Study Log** to open the new file. Disabling logging stops future study events and leaves existing data in place. Send history is separate and can be cleared with **Clear History**. See [the schema](handoff/lane-3.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| CLI not found | Ensure the executable is visible to VS Code or set `claudePath`; use clipboard sending if needed |
| Review fails | Check CLI login, model access and the reported error; local rule checks remain available |
| No automatic model review | Expected: use Enhance when you want model assistance |
| Missing-file warning seems wrong | Check the open workspace; the filename index is capped at 20,000 files and excludes common generated directories |
| Terminal command fails | Check `claudePath` points to a CLI executable; use clipboard mode for other integrations |
| No study log | Enable logging, then Send; opening the panel or using Copy creates no event |

Stale model output is dimmed. Late responses from a previous draft are ignored.
