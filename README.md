# Prompt Preflight

Preflight (working name) gives feedback on coding-agent prompts before they're sent. We don't try to improve the agent's execution itself (Codex/Claude Code are far ahead there).

Vague prompts make agents guess, loop and spend tokens. Preflight checks the prompt while the user writes it, asks for missing goals, context and success criteria, and only then hands it to Claude Code. Users write a prompt the agent can solve in one run, and learn what a complete prompt looks like.

Write the prompt in the **Prompt Preflight** panel (activity bar, or `Cmd/Ctrl+Alt+P`). The panel runs the rule checks as you type, starts the quick review when you pause, and offers deep review, the improved prompt, and send.

## Cheap checks first

| Tier | When | What | Cost |
|---|---|---|---|
| 1. Rules | every keystroke | `core/src/analyze.ts`: highlights, rule findings, a deterministic pre-check score, and questions | free |
| 2. Quick review | after a typing pause | one model call that returns the four-dimension score, issues, and questions; this is the only model score | provider tokens |
| 3. Deep review | on request | issues, questions, assumptions, and context gaps; never a score | provider tokens |
| 4. Improved prompt | after a deep review with a question | a separate rewrite that leaves unknown details as `[placeholders]` | provider tokens |
| 5. Send | button / Cmd+Enter | Claude Code starts in a terminal with the prompt, or the prompt is copied | agent tokens |

Tiers 2 to 4 run through `claude -p` with the user's own Claude login: no API key, no tools, no project settings. The provider layer is ready for a Codex adapter.

Settings live under `promptPreflight.*`: provider, model, quick and deep models, thinking effort, pause delay, send target, code inclusion, the study log, and debug tracing.

## Score

Two scores have different jobs.

- The **rule pre-check** is free and immediate. It scores Target, Action, Scope, and Done when, 25 points each. A score below 65, or a secret, unfilled placeholder, or risky work, marks the prompt "should clarify": the hook blocks it, and Send asks for confirmation.
- The **quick review score** is model-scored and asynchronous. It returns a `ScoreReport` with the four dimensions, a 0-100 total, and a level: `clear` at 80 or more, `needs-work` at 55 or more, `vague` below 55. It records the provider, model, thinking effort, rubric version, and prompt hash. This is the only model score.
- A **deep review never scores**. It returns issues, questions, assumptions, and context gaps. The improved prompt is a separate action, enabled only when the deep review asked at least one question.

Quick and deep reviews keep at most 20 issues and 20 questions. A question has at most 3 options.

Rule ideas borrowed (MIT) from [akg268/prompt-preflight](https://github.com/akg268/prompt-preflight) (gate on ambiguity, question lists, `[preflight:skip]`, calibration corpus) and [preflight-dev/preflight](https://github.com/preflight-dev/preflight) (four-part score, vague verbs and pronouns, candidate files in questions).

## Privacy and data flow

### What is sent to the model provider

| Content | When it is sent |
| --- | --- |
| Your draft and Q&A answers | Always, when you run a model check. `includeCode` gates code only. |
| Code excerpts, diagnostics, session code | Only when the effective `promptPreflight.context.includeCode` allows it, after secret redaction. The effective value stays `off` until you accept the consent notice. |

`promptPreflight.context.includeCode`:

| Value | Behavior |
| --- | --- |
| `off` | No workspace code, diagnostics, or session code is sent. Your draft and Q&A are still sent. |
| `prompt-files` (default) | Only files explicitly referenced with `@` in the draft are sent. |
| `workspace` | Every non-excluded workspace file may be sent. |

Files named `.env`, `.env.*`, `credentials.json`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, and anything under `node_modules`, `.git`, or the build directories (`dist`, `out`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `target`) are never sent, even when referenced with `@`. Absolute paths and paths outside the workspace are excluded too. Untitled buffers and virtual documents are excluded.

Secrets are redacted with the same patterns the rule checks use (Anthropic, AWS, GitHub, Slack tokens, private-key headers, and key/password assignments). Each match is replaced with `[redacted]`. This catches single-line tokens; a secret split across lines is not matched, and the private-key pattern covers the `BEGIN ... PRIVATE KEY` header only, not the key body. Both gaps are tracked for ticket #23.

### Consent

On first activation the extension shows a modal notice that links each provider's data-handling page:

- Claude Code: https://code.claude.com/docs/en/data-usage
- Codex: https://openai.com/policies/privacy-policy/

The Codex provider adapter is not implemented yet (ticket #10); the link is here for when you can select it as provider.

Your decision is stored once in VS Code global state under `promptPreflight.consent.v1` (consent version 1). Declining turns `includeCode` off and does not block the rest of the extension. Dismissing the notice without choosing shows it again on the next start. A later consent version asks again.

Code inclusion stays off until the notice is accepted. The effective value is `off` while no accepted record exists, even if the setting still reads `prompt-files`.

### What stays on this machine

Drafts, Q&A, reviews, session slices inside review records, and send records are stored unencrypted under `context.globalStorageUri`. They never leave the machine except inside a model request. `promptPreflight.clearHistory` deletes them.

The study log (`promptPreflight.studyLog.enabled`) is opt-in, written separately, and is not deleted by `clearHistory`. The optional debug trace is stored in its own directory and is removed by `promptPreflight.clearDebugLog`, not by `clearHistory`. Nothing else is collected: there is no telemetry by default.

## Observability

The review records are in `reviews.jsonl` under the extension's global storage:

```text
<context.globalStorageUri>/reviews.jsonl
```

For VS Code stable on macOS, that resolves to:

```text
~/Library/Application Support/Code/User/globalStorage/prompt-preflight.prompt-preflight/reviews.jsonl
```

The same directory holds:

- `sends.jsonl` - exact sent text and prompt hashes
- `drafts.jsonl`
- `questions.jsonl`

Quick and deep review records share `reviews.jsonl`.
The derived `SessionSlice` is stored inside the review record. There is no `slices.jsonl`.

The repository creates each file on its first append, including the global storage directory.

The current panel does not append draft, question, review, or send records yet.
It writes the opt-in study log (`study-log.jsonl`) on send, and the optional debug trace when `promptPreflight.debug` is on.
The four JSONL interfaces above are the control-plane contract for the panel integration in #43, #46, and #47.
Without the Claude CLI, the health check returns `provider-missing`; no review runs and no review record is created.

### Debug trace

`promptPreflight.debug` enables a separate local evaluation trace. It is off by default.
`promptPreflight.debugLogDir` selects the directory. Empty uses `<context.globalStorageUri>/debug`; a relative path resolves under it; an absolute path is used as is.
The file is `llm-trace.jsonl`. Rotation uses 10 MB and 5 files. The directory is mode `0700`; files are mode `0600` on POSIX.
The trace is independent of the study log and of the four files above.

The trace uses OpenTelemetry spans and logs. Each JSONL record carries `schemaVersion`, `recordType` (`span` or `log`), trace and span ids, timestamps, attributes, events, and resource metadata. Spans cover `session`, `review.quick`, `review.deep`, `health.check`, and `llm.call`. Logs cover requests, process invocation, stdin, stdout, stderr, responses, errors, review parsing, UI actions, and storage. Standard `gen_ai.*` attributes carry the model and token usage; `prompt_preflight.*` attributes carry mode, thinking effort, generation method, timeout, RTT, prompt hash, exit code, signal, and cost.

The `Prompt Preflight Debug` output channel shows colored levels and phase labels. It previews large payloads. The JSONL file holds the full payloads. The channel follows the VS Code log level; set it to Debug to show process, stdin, input, and span lines.
The first enable shows a warning because full prompts, code, and model responses are stored locally. The file is never uploaded.

Commands:

- `Prompt Preflight: Open Debug Log` shows the colored channel.
- `Prompt Preflight: Open Debug Log File` opens `llm-trace.jsonl`.
- `Prompt Preflight: Clear Debug Log` deletes the trace files. `Prompt Preflight: Clear History` keeps the debug trace and the study log.

### Machine-agnostic setting

The machine-agnostic seam is `context.globalStorageUri`.
It is a VS Code URI, not an absolute path.

The JSONL filenames are hardcoded constants in the repository adapter.
The storage root is not a Prompt Preflight setting.
VS Code controls it, and it can be relocated with `--user-data-dir` or a VS Code profile.

## Layout

```
core/       control plane, plain TypeScript, no VS Code dependency
  src/analyze.ts: rule checks and the rule pre-check score
  src/schema.ts: review schemas, rubric, score parser
  src/model.ts: provider profiles and the provider factory
  src/claudeCli.ts: Claude Code CLI adapter
  src/context.ts: bounded context assembler and manifest
  src/promptFiles.ts: explicit @ file references
  src/review.ts: review prompt builders
  src/repository.ts: JSONL event repository
  src/errors.ts: feedback error taxonomy
  test/corpus.jsonl: rule cases
  test/review-corpus.jsonl: review cases
extension/  VS Code client: panel, workspace and language tools, sessions, send, study log
  src/panel.ts: webview panel and review flow
  src/sessionSlice.ts: bounded Claude and Codex session reader
  src/sessionLocator.ts: session selection
  src/codeTools.ts: agent tools over LSP types
  src/vscodeCodeTools.ts: VS Code LSP adapter and bundled rg
  src/debug/: OTel trace, JSONL exporters, rotation, output channel
  src/privacy.ts: consent and redaction
  src/repository.ts: storage composition
hook/       Claude Code UserPromptSubmit hook (rules only)
e2e/        VS Code extension-host walkthroughs
```

## Develop

```bash
npm install
npm test              # vitest: unit tests + corpus
npm run typecheck
npm run build         # extension/dist, hook/dist
npm run package       # extension/prompt-preflight-0.1.0.vsix
```

Run the extension: open this folder in VS Code, press F5 (launch config "Run Extension").
Install the build: `code --install-extension extension/prompt-preflight-0.1.0.vsix`.

Found a wrong result? Add a rule case to `core/test/corpus.jsonl` or a review case to `core/test/review-corpus.jsonl`, then make the test pass.

## Claude Code hook

Blocks vague prompts typed directly into Claude Code and shows the questions instead. Build it, then add to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/prompt-preflight/hook/dist/hook.js" }] }
    ]
  }
}
```

Add `[preflight:skip]` to a prompt to send it as is. On any error the hook lets the prompt through.

## User study

Enable `promptPreflight.studyLog.enabled` and set `promptPreflight.studyLog.participantId`. Each send appends one line to `study-log.jsonl` (command *Prompt Preflight: Open Study Log*): prompt, first and final score, draft time, rules hit, reviews used, whether the improved prompt was used, and Preflight's own tokens and cost. The agent's tokens are in Claude Code's session transcripts (`~/.claude/projects/`), not yet merged into the log.
