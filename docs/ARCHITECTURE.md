# Current architecture

This is a source-based description of the prototype, not the target design in [issue #28](https://github.com/Diekgbbtt/Preflight/issues/28).

## Packages and boundaries

| Location | Responsibility |
|---|---|
| `core/src/analyze.ts`, `patterns.ts`, `types.ts` | Pure synchronous analysis, regexes, four score dimensions, findings and clarification questions |
| `core/src/review.ts` | Review prompts, `ModelRunner` contract, JSON extraction and review parsing |
| `core/src/claudeCli.ts` | Node child-process adapter and CLI usage parsing |
| `extension/src/extension.ts` | VS Code activation, commands, global storage and service wiring |
| `extension/src/panel.ts` | Draft state, rule calls, timers, model reviews, send confirmation and study events |
| `extension/media/panel.js`, `panel.css` | Plain JavaScript webview, highlights, feedback and saved webview text |
| `extension/src/workspace.ts` | File-name index, git recent files and short project notes |
| `extension/src/send.ts`, `studyLog.ts` | Terminal/clipboard handoff and optional JSONL storage |
| `hook/src/hook.ts` | Rule-only Claude Code submission hook |

`core` has no VS Code imports. Its CLI adapter does use Node I/O; only the rule analysis itself is pure. `core` exports TypeScript sources consumed by the extension and hook bundles rather than a separate compiled library.

## Review flow

The webview posts input to `PromptPanel`. The host calls `analyze` with workspace path lookup, returns analysis, aborts the prior quick request and resets the pause timer. Quick and deep requests call `review` through an injected `ModelRunner`; the panel currently constructs the Claude runner directly. The CLI receives the review input through stdin and runs without a shell, with a 120-second timeout and a 10 MiB output buffer.

The workspace index scans filenames, lowercases them and supports suffix matching. It is not a code-content or symbol index. Git status and the last five commits supply up to eight recent names. The first workspace folder supplies the terminal/review working directory, while VS Code file search can span workspace folders. These approximations can produce ambiguous path results.

Quick requests are cancelled on edits; deep requests are cancelled when another deep request starts, but not on an edit. The webview compares returned draft text with current text to dim stale results. The host stores the latest improved prompt without a draft revision guard. There is no durable feedback session or Q&A history.

## Send and hook

Send re-analyzes the trimmed draft, optionally confirms, then either copies it or opens a fresh terminal and sends a shell command. This terminal path differs from the shell-free review adapter. A successful handoff is not an agent completion signal. A study-log write follows handoff, then draft counters reset.

The hook reads one JSON object from stdin (`prompt`, optional `cwd`). It checks path existence only for non-absolute references containing `/`; bare filenames are accepted. When clarification is needed it emits a JSON block decision and reason. Malformed input and other errors fail open. The feedback includes the submitted prompt, so detected secrets can also be echoed in hook output.

## Scores and contracts

Target, Action, Scope and Done each contribute up to 25 points. Non-trivial levels are clear at 80+, needs-work at 55–79, and vague below 55. The clarification threshold and exceptions are separate from these display levels; see [usage](USAGE.md). Model verdicts are separate from rule scores.

Current review parsing tolerates JSON fences and surrounding text. A future strict versioned model score schema is tracked in [#40](https://github.com/Diekgbbtt/Preflight/issues/40); it is not implemented here. Planned providers, persistent sessions, context manifests and instruction loading are likewise roadmap items, not current APIs.
