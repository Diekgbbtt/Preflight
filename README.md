# Prompt Preflight

Preflight (working name) gives feedback on coding-agent prompts before they're sent. We don't try to improve the agent's execution itself (Codex/Claude Code are far ahead there).

Vague prompts make agents guess, loop and spend tokens. Preflight checks the prompt while the user writes it, asks for missing goals, context and success criteria, and only then hands it to Claude Code. Users write a prompt the agent can solve in one run, and learn what a complete prompt looks like.

## Documentation

- [Install, settings, workflow and troubleshooting](docs/USAGE.md)
- [Current architecture and data flow](docs/ARCHITECTURE.md)
- [Contributing and validation](CONTRIBUTING.md)
- [Prioritized improvement suggestions and linked GitHub issues](docs/IMPROVEMENTS.md)

The linked guides describe the current prototype separately from the planned architecture in [issue #28](https://github.com/Diekgbbtt/Preflight/issues/28).

Write the prompt in the **Prompt Preflight** panel (activity bar, or `Cmd/Ctrl+Alt+P`). Local rules run while you type; **Enhance** requests model feedback and an improved prompt.

## Cheap checks first

| Tier | When | What | Cost |
|---|---|---|---|
| 1. Local rules | every input; notes settle after 300 ms | Target, action, scope, completion, clarity, risk and privacy checks | free |
| 2. Enhance | explicit button click | Model review and a separate improved prompt with unknown details left as placeholders | CLI-reported usage |
| 3. Send | button / Cmd+Enter | Starts Claude Code or copies the prompt; never starts a model review | agent tokens after handoff |

Typing, pauses and Send do not call the LLM. Enhance uses `claude -p` with the user's Claude login. The old `quickReviewOnPause` setting is ignored, including existing opt-ins.


## Score

Live feedback comes from local rules. The panel shows a local status and Target/Action/Scope/Done checklist, with detailed highlights, notes and questions. These are heuristic checks, not a model quality score. There is no automatic numeric model score.

**Enhance** explicitly requests a model review and, when it identifies questions, a separate rewrite. The draft changes only when **Use this prompt** is clicked. The quick-scoring API remains available for experiments, but the panel does not schedule it automatically.

Send is advisory by default. Enable `promptPreflight.gateSending` to confirm when local warnings remain; Send never calls a model. See [the current behavior](docs/USAGE.md#write-review-and-send).


Rule ideas borrowed (MIT) from [akg268/prompt-preflight](https://github.com/akg268/prompt-preflight) (gate on ambiguity, question lists, `[preflight:skip]`, calibration corpus) and [preflight-dev/preflight](https://github.com/preflight-dev/preflight) (four-part score, vague verbs and pronouns, candidate files in questions).

## Privacy and data flow

The control-plane foundation is merged, but the current panel still uses the legacy review path: it sends the draft, rule findings and short workspace filename notes. It does not yet attach code files, session slices or Q&A, or persist draft and review records through the new repositories. Draft redaction is not applied on that legacy path. The policy below describes the new context consumers; panel integration remains follow-up work in #43, #46 and #47.

### What is sent to the model provider

| Content | When it is sent |
| --- | --- |
| Your draft and Q&A answers | Always, when you run a model check. `includeCode` gates code only. |
| Code excerpts, diagnostics, session code | Only when the effective `promptPreflight.context.includeCode` allows it, after secret redaction. The effective value stays `off` until you accept the consent notice. |

`promptPreflight.context.includeCode`:

| Value | Behavior |
| --- | --- |
| `off` | No workspace code, diagnostics, or session code is sent. Your draft and Q&A are still sent. |
| `prompt-files` (default) | Only files explicitly referenced with `@` in the draft may be included. The legacy `active-file` value maps to `prompt-files`. |
| `workspace` | Every non-excluded workspace file may be sent. |

For context consumers using the policy, files named `.env`, `.env.*`, `credentials.json`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, and anything under `node_modules`, `.git`, or the build directories (`dist`, `out`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `target`) are excluded from file context. Absolute paths and canonical targets outside the workspace are excluded too. Both a symlink reference and its target must pass exclusions before the file is read. Untitled buffers and virtual documents are not resolved as explicit `@` file references. Text pasted into the draft is still draft content.

The Claude Code CLI itself never reads files and never sees the workspace as its working directory. The adapter neutralizes `@path` mentions in the prompt it hands to the CLI (a zero-width space after each `@`) and runs the CLI in a fresh empty temporary directory, so file content reaches the provider only through the context above (`docs/adr/0001`, `docs/adr/0002`). `npm run live:privacy` checks this boundary against the real CLI; run it after a Claude CLI update or before a release.

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

The study log (`promptPreflight.studyLog.enabled`) is opt-in, written separately to `study-events-v2.jsonl`, and is not deleted by `clearHistory`. The optional debug trace is stored in its own directory and is removed by `promptPreflight.clearDebugLog`, not by `clearHistory`. Nothing else is collected: there is no telemetry by default.

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

The current panel writes exact sent prompts to `sends.jsonl`, shared with Clear History. It does not append draft, question, or review records yet.
It writes the opt-in study log (`study-events-v2.jsonl`) on send, and the optional debug trace when `promptPreflight.debug` is on.
The four JSONL interfaces above are the control-plane contract for the panel integration in #43, #46, and #47.
Without the Claude CLI, Enhance reports `provider-missing`. Reviews invoke the CLI directly without a per-review health probe.

### Debug trace

`promptPreflight.debug` enables a separate local evaluation trace. It is off by default.
`promptPreflight.debugLogDir` selects the directory. Empty uses `<context.globalStorageUri>/debug`; a relative path resolves under it; an absolute path is used as is.
The file is `llm-trace.jsonl`. Rotation uses 10 MB and 5 files. The directory is mode `0700`; files are mode `0600` on POSIX.
The trace is independent of the study log and of the four files above.

The trace uses OpenTelemetry spans and logs. Each JSONL record carries `schemaVersion`, `recordType` (`span` or `log`), trace and span ids, timestamps, attributes, events, and resource metadata. Spans cover `session`, `review.quick`, `review.deep`, `review.improve`, and `llm.call`. Logs cover requests, process invocation, stdin, stdout, stderr, responses, errors, review parsing, UI actions, and storage. Standard `gen_ai.*` attributes carry the model and token usage; `prompt_preflight.*` attributes carry mode, thinking effort, generation method, timeout, RTT, prompt hash, exit code, signal, and cost.

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
  src/analyze.ts: local advisory rules and legacy hook analysis
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
npm run live:privacy  # manual: privacy boundary against the real Claude CLI
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

The hook is a separate, opt-in rule-only policy. It cannot read VS Code settings, including `gateSending`. In the hook only, add `[preflight:skip]` to bypass ambiguity checks; detected secrets still require clarification. On any error the hook lets the prompt through.

## User study

Enable `promptPreflight.studyLog.enabled` and set `promptPreflight.studyLog.participantId`. Append-only `study-events-v2.jsonl` links send, quick score, review, agent usage and outcome events by draft/send/session IDs. Model observations supply first/final scores; unavailable scores stay null. The exact sent draft is stored once in `sends.jsonl`. Preflight tokens stay separate from agent input/output/cache counters. Pending collection survives restart and samples the exact Claude session; terminal exit confirms the final observation. Unreported agent cost stays null. Clipboard sends have no automatic agent attribution. Recovery observations are cumulative snapshots: use the latest available observation per send, never sum them.

Legacy `study-log.jsonl` sends migrate without treating their symbolic scores as model scores. Run *Prompt Preflight: Open Study Log* to open the new log. See [schema, migration and verification](docs/handoff/lane-3.md).

Historical quick-review measurements before switching to explicit-only enhancement (three paired Haiku samples, medium effort): median **8.05 s → 5.42 s**, about **33% lower**. The two-second goal remains unmet; [method and limitations](docs/handoff/lane-3.md#latency).
