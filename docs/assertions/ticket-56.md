# Assertions - work-item "Claude CLI reads @file mentions in review prompts, bypassing the privacy policy"

**Source:** Diekgbbtt/Preflight#56
**Seams under assertion:** `core/claudeCli` (provider and runner stdin and spawn seams), `core/review` system prompt builders, `e2e/live-privacy-check.mjs` (live edge: real Claude CLI)

Phase D catalogue, narrow route. Reproduction evidence (2026-11-27, Claude CLI 2.1.327): relative `@probe.ts` returned `zebra-4417`; `@.env` returned `not-a-secret-8812`; absolute `@<tmp>/probe.ts` returned `abs-7742`; `@~/.preflight-56-probe.txt` returned `home-9931`; the zero-width-space control returned `NONE`; a path-free draft returned the full spawn cwd. The `--system-prompt` flag value is not mention-expanded (`NONE`).

## Contract predicates (integration)

| id | seam | delivery semantic | input | observable | yields |
|---|---|---|---|---|---|
| C1 | `ModelRequest` -> `execClaude` stdin | success and outlier | draft with `@probe.ts`, `@.env`, `@/etc/hosts`, `@~/.ssh/config` | no unchanged `@` mention in the stdin payload (every `@` is followed by U+200B); the caller's request object is byte-identical afterwards | `core/test/claudeCli.test.ts` "writes a stdin payload whose @ mentions are neutralized and leaves the request untouched" |
| C2 | `ModelRequest` -> `execClaude` stdin | empty-valid | draft without any `@` | stdin payload byte-identical to `request.user` | `core/test/claudeCli.test.ts` "leaves a draft without @ byte-identical on stdin" |
| C3 | `neutralizeMentions` | success and outlier | no `@`; `a@b@c`; `user@example.com`; trailing `@`; `@~/x`; `@/abs` | exactly one U+200B after each `@`; no other character changes; no-`@` input is unchanged | `core/test/claudeCli.test.ts` `neutralizeMentions` cases |
| C4 | `execClaude` spawn cwd | degradation | caller cwd contains files | the child's cwd is a fresh empty directory under `os.tmpdir()`, not the caller cwd; its listing is empty | `core/test/claudeCli.test.ts` "spawns the CLI in a fresh empty temporary directory" |
| C5 | `execClaude` cleanup | ordering | success call, then a nonzero-exit call | after each call settles, the spawn directory reported by the `process` trace event no longer exists | `core/test/claudeCli.test.ts` "removes the temporary spawn directory after the call" |
| C6 | `claudeCliRunner` relative `claudePath` | compatibility | `claudePath: "./fake.js"`, caller cwd `FAKE_DIR` | the CLI resolves against the caller cwd and the call succeeds while the spawn cwd is the temp dir | `core/test/claudeCli.test.ts` "resolves a relative claudePath against the caller cwd" |
| C7 | `LlmTrace.stdin` | truthfulness | recording trace around a runner call | the stdin event records the neutralized payload; the request event records the original user text | `core/test/claudeCli.test.ts` trace cases (updated) |
| C8 | review and improve system builders | guard | `buildReviewRequest` quick and deep, `buildImprovedPromptRequest` | every built system string contains no `@` followed by a path-like character | `core/test/review.test.ts` "keeps @ mentions out of the built system prompts" |

## Walkthrough predicates (live edge: real Claude CLI, operator login and network)

| id | grounds | entry seam | input | path | terminal | observed | yields |
|---|---|---|---|---|---|---|---|
| E1 | #56 reproduction call 2 (excluded file) | neutralized stdin of `claude -p` | draft asking for the value of `FAKE_TOKEN` in `@.env`, neutralized as the adapter does | `e2e/live-privacy-check.mjs` -> `claude -p --tools "" --setting-sources "" --system-prompt` in a fresh empty spawn dir | result is exactly `NONE` | script prints PASS per case | case 1 |
| E2 | #56 open point: absolute paths | same | draft asking for `ABS_7742` in `@<abs probe path outside the workspace>` | same | `NONE` | script | case 2 |
| E3 | #56 open point: `~` paths | same | draft asking for `HOME_9931` in `@~/.preflight-privacy-probe.txt` | same | `NONE`; the probe file is removed afterwards | script | case 3 |
| E4 | #56 lower-severity working-directory leak | spawn cwd | path-free draft asking for the absolute cwd | same | the reply names the spawn directory (positive control that the CLI is alive) and contains no part of the workspace path: neither its realpath nor its basename | script | case 4 |

Frequency: E1-E4 run manually through `npm run live:privacy` after a Claude CLI update and before a release. They need the user's Claude login and network, so they are not wired into `npm test` or `npm run e2e`.

Bootstrap: a real `claude` CLI with the user's login. All marker values are fake (`zebra-4417`, `not-a-secret-8812`, `abs-7742`, `home-9931`).
