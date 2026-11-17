# Lane 1: control plane

This PR delivers the Lane 1 control plane for Prompt Preflight.
It now includes the response to the PR #49 review.
The branch is not ready to merge until the owner approves the contracts and the residual follow-ups.

## Tickets

| Ticket | Merge commit | Tests at merge | Reviewer |
| --- | --- | --- | --- |
| #40 Review schema and rubric versioning | `cf5cdbb` | 111 passed | PASS |
| #41 Privacy and consent boundary | `bf2bb83` | 151 passed | PASS |
| #35 JSONL repository and session persistence | `621906d` | 187 passed | PASS |
| #39 Model provider profiles | `986b610` | 227 passed | PASS |
| #42 Feedback errors and degraded modes | `507ee22` | 295 passed | PASS |
| #36 Context assembler and manifest | `495b528` | 322 passed | PASS |
| #37 Language context provider | `96ce460` | 442 passed | PASS |
| #38 Current session slice reader | `e366d25` | 518 passed | PASS |
| Review fixes | `ec10b1f` | 524 passed three times; e2e 9/9 | PASS |

Merges are fast-forward, so the ticket tips are ancestors of the branch.
The review-fix tip is `ec10b1f`.
The lane base is `main` at `24dc845`.

## Review response

The refusal was bounded to seven inline comments.
All seven are closed.

| Comment | Change |
| --- | --- |
| `ScoreReport.thinkingEffort` hard-coded union | Provider-native `string`; `xhigh` and `max` pass through to `--effort`. |
| `ScoreMeta.thinkingEffort` hard-coded union | Same loosening; the Claude adapter rejects only an empty value. |
| `DeepReview.improvedPrompt` | Removed. A separate `ImprovedPrompt` action is enabled only after a deep review with a question. |
| Issue and question ceilings of 3 | Raised to 20 each; options stay capped at 3. |
| Deep review parses a score | Deep review never scores. Score is quick-only and asynchronous. |
| Active editor, selection, and open editors as context | Removed. The draft uses explicit `@path` references; the `prompt-files` source reads only referenced files and checks policy before reading. |
| Bespoke LSP layer | Replaced with agent tools over LSP types and a bundled `rg` fallback. |

The owner requirements are also closed:

- `@vscode/ripgrep` supplies the bundled binary; no system `rg` is needed.
- The LSP tools try first; empty results with a query fall over to text search.
- `docs/handoff/lane-1.md` has a concrete panel seam section.
- Real Codex `event_msg.item_completed` fixtures replace the assumed `exec_command_begin/end` format.
- Windows path rules have `path.win32` tests and a manual checklist.

## Stacked fix

PR #50 fixes a Codex session parser gap.
Current Codex sessions emit `apply_patch` as `custom_tool_call`, not `function_call`.
The parser now records those calls, extracts every patch path, and dedupes the matching `FileChange`.
The fix adds a real-shape fixture, C35, and e2e E11.
PR #50 is based on this branch and remains draft for review.
Do not merge this PR without #50 or an equivalent fix.

## Verification

- `npm run typecheck`: passed three times.
- `npm test`: 20 test files, 524 tests passed three times.
- `npm run build`: passed three times; the build copies `rg` or `rg.exe` to `extension/dist`.
- `npm run e2e`: 9 of 9 tests passed on 2026-11-17.
- E2E coverage:
  - explicit `@` file context
  - quick score and separate deep review and improved prompt
  - consent off never reads the file
  - send record exact text and shared hash
  - Claude prompt-files slice
  - real Codex two-call slice
  - TypeScript `greet` symbols
  - `MissingNeedle` fallback to bundled `rg`
  - missing CLI maps to `provider-missing`
- E2E first run passed 8 of 9.
  E8 failed because `rg` read stdin instead of the workspace.
  The adapter now passes an explicit `.` search path, and the rerun passed 9 of 9.

## Contracts

`docs/handoff/lane-1.md` is the authoritative handoff.
It records:

- the v2 review schema and separate improved prompt;
- provider-native thinking effort;
- the `prompt-files` source and privacy policy;
- the LSP code tools, caps, and fallback;
- real Codex events and Windows path rules;
- the concrete panel seams for #43, #46, #47, and #15.

The single-copy invariants hold:

- One `hashPrompt` in `core/src/schema.ts`.
- One `SendRecord` shape; the exact sent text lives only in `sends.jsonl`.
- One `DeepReview` shape; `reviews.jsonl` stores it plus the derived `SessionSlice`.
- No `slices.jsonl`.
- One `isOutsideWorkspace` helper.

## Residual risks and follow-ups

- The panel is not wired to the new provider, context, session, or repository paths.
  #43, #46, and #47 own that integration.
- The live Windows run is not measured.
  The path rules are unit-tested with `path.win32`; `docs/windows.md` has the manual steps.
- Python and Rust LSP parity are manual.
  TypeScript is measured by e2e E7.
- The legacy `Review`, `review()`, `parseReview`, and `LEGACY_DEEP_REPLY_SCHEMA` path remains until #46.
  New code does not use it.
- The Claude Windows path encoding is covered by the pure sanitizer test, not a live run.
- A live session's newest line can lag by one write.
- Split-line secrets and private-key bodies belong to #23.

## Draft status

Do not merge.
The PR stays draft until the owner reviews the contracts and accepts the residual risks.
The review-fix branch is ready to push and update this PR.
