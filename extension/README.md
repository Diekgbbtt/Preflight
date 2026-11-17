# Prompt Preflight

Feedback on prompts for coding agents before you send them.

Write your prompt in the **Prompt Preflight** panel (activity bar, or `Cmd/Ctrl+Alt+P`):

- **While typing:** rule checks highlight missing targets, vague verbs, unclear references, placeholders and secrets, and score the prompt (Target, Action, Scope, Done when).
- **When you pause:** a small model (Haiku) looks for gaps the rules missed.
- **On request:** *Detailed feedback* explains each issue and suggests an improved prompt, with unknown details left as `[placeholders]`.
- **Send:** starts Claude Code in a terminal with your prompt, or copies it.

Model checks run through the Claude Code CLI with your own login (`claude -p`). No API key needed.

Settings: `promptPreflight.*` (models, pause delay, send target, study log).

## Privacy and data flow

### What is sent to the model provider

| Content | When it is sent |
| --- | --- |
| Your draft and Q&A answers | Always, when you run a model check. `includeCode` gates code only. |
| Code excerpts, diagnostics, session code | Only when the effective `promptPreflight.context.includeCode` allows it, after secret redaction. The effective value stays `off` until you accept the consent notice. |

`promptPreflight.context.includeCode`:

| Value | Behavior |
| --- | --- |
| `off` | No workspace code, diagnostics or session code is sent. Your draft and Q&A are still sent. |
| `active-file` (default) | Only the active file, or an explicit selection, is sent. |
| `workspace` | Every non-excluded workspace file may be sent. |

Files named `.env`, `.env.*`, `credentials.json`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, and anything under `node_modules`, `.git`, or the build directories (`dist`, `out`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `target`) are never sent, even as a selection. Absolute paths and paths outside the workspace are excluded too. Untitled buffers and virtual documents are excluded for active-file, workspace, and open-editor sources, but an explicit selection inside one may be sent after secret redaction.

Secrets are redacted with the same patterns the rule checks use (Anthropic, AWS, GitHub, Slack tokens, private-key headers, and key/password assignments). Each match is replaced with `[redacted]`. This catches single-line tokens; a secret split across lines is not matched, and the private-key pattern covers the `BEGIN ... PRIVATE KEY` header only, not the key body. Both gaps are tracked for ticket #23.

### Consent

On first activation the extension shows a modal notice that links each provider's data-handling page:

- Claude Code: https://code.claude.com/docs/en/data-usage
- Codex: https://openai.com/policies/privacy-policy/

Codex support is not implemented yet (ticket #10); the link is here for when you can select it as provider.

Your decision is stored once in VS Code global state under the key `promptPreflight.consent.v1` (consent version 1). Declining turns `includeCode` off and does not block the rest of the extension. Dismissing the notice without choosing shows it again on the next start. A later consent version asks again.

Code inclusion stays off until the notice is accepted. Context consumers read the effective value through `consentedIncludeCode(setting, consent)`, which returns the setting only for an accepted consent and `off` otherwise, so a dismissed notice leaves code off even while the setting still reads `active-file`.

### What stays on this machine

Drafts, Q&A, reviews, session slices inside review records, and send records are stored unencrypted under `context.globalStorageUri`. They never leave the machine except inside a model request. `promptPreflight.clearHistory` deletes them.

The study log (`promptPreflight.studyLog.enabled`) is opt-in, written separately, and is not deleted by `clearHistory`. Nothing else is collected: there is no telemetry by default.
