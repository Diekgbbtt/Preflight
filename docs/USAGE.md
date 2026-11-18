# Using Prompt Preflight

This guide describes the current prototype. Planned capabilities are listed in [improvement suggestions](IMPROVEMENTS.md).

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
2. Rules run on each input and show a score, notes and up to three questions.
3. A quick review runs after a pause when the draft has at least five words, is not classified as trivial, and differs from the last quick-review draft.
4. **Detailed feedback** requests a deeper review. **Use this prompt** replaces the draft with its suggestion. Fill in any square-bracket placeholders.
5. **Send** or Cmd/Ctrl+Enter starts a fresh Claude Code terminal session, or copies the draft when configured. **Copy** copies directly without the Send confirmation or study-log event.

The displayed score comes from local rules. Model reviews add findings and a verdict; they do not change the numeric score. A high score is a heuristic, not evidence that the task will succeed.

Send asks for confirmation when local analysis requires clarification. The hook instead blocks such prompts. `[preflight:skip]` bypasses ambiguity checks, but detected secrets still require clarification. Empty prompts are ignored. Risk findings only gate below 80; a score below 65, an unfilled placeholder, or a non-concrete target without success criteria can also trigger clarification. Trivial commands receive a special 100-point classification, subject to secret detection.

## Settings

All settings below have the `promptPreflight.` prefix.

| Setting | Default | Effect |
|---|---|---|
| `claudePath` | `claude` | CLI executable; review execution uses it directly, terminal sending inserts it into shell text |
| `quickModel` | `haiku` | Quick-review model |
| `deepModel` | `sonnet` | Detailed-review model |
| `quickReviewOnPause` | `true` | Automatic quick reviews |
| `pauseMs` | `1500` | Pause before a quick review; minimum 500 ms |
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

Detailed feedback still calls the model when requested. Clipboard mode is useful for other agents and shells: terminal sending currently uses POSIX quoting and has no direct integration with Claude Code or Codex chat inputs.

## Data and logging

Rules run locally. A model review sends the draft, rule messages, top-level workspace entry names and up to eight recently changed file names through the Claude CLI. The context builder does not explicitly attach file contents or session transcripts. The CLI receives `--tools ""`, `--setting-sources ""` and a custom system prompt; canonical instruction-file isolation is a planned improvement, not a verified privacy guarantee.

Secret detection reports findings but does not redact the draft or prevent an automatic or requested review from receiving it. Do not treat it as a privacy boundary. See [the improvement plan](IMPROVEMENTS.md#privacy-before-context-expansion).

When logging is enabled, Send writes an event even in clipboard mode. It records the full trimmed prompt, workspace name, participant, timestamp, target, scores, dimensions, rule IDs, drafting duration, review counts, whether the rewrite was used, and Preflight tokens/cost. It does not record execution outcomes or agent token usage. Copy alone produces no event.

The file is `study-log.jsonl` under VS Code's extension global storage (`ExtensionContext.globalStorageUri`), outside the project. Run **Prompt Preflight: Open Study Log** to locate it after the first logged send. Disabling logging stops future events and does not delete existing data. To delete it, use the opened document's file path, then remove the file. Review prompt contents before sharing study data.

## Troubleshooting

| Symptom | Check |
|---|---|
| CLI not found | Ensure the executable is visible to VS Code or set `claudePath`; use clipboard sending if needed |
| Review fails | Check CLI login, model access and the reported error; local rule checks remain available |
| No quick review | Check the setting, five-word minimum, trivial classification and whether that draft was already checked |
| Missing-file warning seems wrong | Check the open workspace; the filename index is capped at 20,000 files and excludes common generated directories |
| Terminal command fails | Use a POSIX shell with the default executable name or select clipboard mode; executable paths containing spaces need improved handling |
| No study log | Enable logging, then Send; opening the panel or using Copy creates no event |

Stale model output is dimmed, but its rewrite action is currently still available. Re-run detailed feedback after editing before using its rewrite.
