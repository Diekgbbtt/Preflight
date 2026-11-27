# Neutralize @ mentions in the Claude CLI stdin payload

Status: accepted (2026-11-27, issue #56)

`claude -p` expands `@path` mentions in the prompt it receives on stdin and reads those files itself, even with `--tools ""`, `--setting-sources ""`, and `--system-prompt` (verified against Claude CLI 2.1.327). That bypasses the #41 privacy boundary: `includeCode: off`, consent, the exclusion list, redaction, and the context manifest are all ignored, and absolute (`@/etc/hosts`) and home-relative (`@~/.ssh/config`) paths are read too.

Decision: `execClaude` in `core/src/claudeCli.ts` inserts a zero-width space (U+200B) after every `@` in the stdin payload. A zero-width space after `@` disables the CLI mention parser, so the CLI reads no file on its own. The `ModelRequest` object, the UI draft, the stored draft, and the prompt hash stay unchanged; only the bytes handed to the CLI differ. File content reaches the model only through the manifest-governed context path (#41, #46, #47), so "What the model saw" stays truthful.

Considered options: running the CLI in an empty temporary directory only (does not stop absolute or `~` paths), and doing nothing (sends excluded files such as `.env` to the provider). Only the combination of this ADR with ADR 0002 closes every observed leak, so both are one fix (ticket fix option 3).

Consequences:

- The model sees a slightly different draft: an invisible character after each `@`.
- The guard against a CLI parser change is the live privacy check (`npm run live:privacy`), run manually after a Claude CLI update and before a release. A unit test pins the adapter side.
- The stdin trace event records the neutralized payload, because that is what the CLI receives; the request trace event records the original draft.
- The Codex adapter (#10) must give the same guarantee when it is implemented.
