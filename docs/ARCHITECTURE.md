# Current architecture

This describes the active panel and the control-plane foundation merged through PRs #51 and #52. The remaining integration follows [issue #28](https://github.com/Diekgbbtt/Preflight/issues/28).

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

The legacy panel review parser tolerates JSON fences and surrounding text. Structured deep questions are adapted to strings for that panel. The separate versioned schema in `core/src/schema.ts` validates model dimension scores and defines quick review, deep review and improved-prompt contracts. The panel still displays rule scores and uses the legacy review path.

## Merged control-plane foundation

- `core/src/model.ts` resolves provider/model/effort profiles. Claude is implemented; Codex inference remains a stub. The panel uses the resolved profile and CLI health checks, then calls the legacy Claude runner. CLI timeout metadata is retained for classification and retry.
- `core/src/context.ts` assembles bounded context with a manifest and injected redaction. Prompt-file resolution checks canonical workspace and target paths, including symlinks, before permitting reads.
- `extension/src/privacy.ts` defines consent, inclusion policy and secret redaction. Activation prompts for consent; consumers must use the consent-adjusted policy.
- `extension/src/repository.ts` implements JSONL persistence. Activation creates repositories and a Clear History command, but the panel does not yet persist drafts, Q&A, reviews or sends through them.
- Language/code tools support VS Code providers and bundled ripgrep fallback. Session modules discover and parse bounded Claude and Codex transcript slices.

These context, persistence and session components are exercised through unit tests and the E2E facade. They are not yet wired into the normal panel review flow. Instruction loading and durable feedback-service orchestration remain follow-up work. See [the authoritative lane handoff](handoff/lane-1.md) for the implemented contracts and integration seams.
