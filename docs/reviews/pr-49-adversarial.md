# PR #49 adversarial review

**Scope:** `363ea9f..HEAD` on `lane-1/review-fixes`
**Reviewer:** implementing agent, adversarial pass
**Date:** 2026-11-17

## Verdict

The seven review comments are closed in code and tests.
The e2e suite passed 11 of 11 tests on 2026-11-17, including E11 for Codex custom tool calls.
The branch is pushed; PR #49 is a draft. A stacked fix PR covers the Codex `custom_tool_call` gap.

## Review comments

| Comment | Verdict | Evidence |
|---|---|---|
| 2.1 and 2.2 provider-native effort | closed | `ThinkingEffort = string`; `buildClaudeArgs` passes `xhigh` unchanged; `validateProfile` rejects only empty. |
| 2.3 separate improved prompt | closed | `DeepReview` has no `improvedPrompt`; `ImprovedPrompt`, `canImprove`, `buildImprovedPromptRequest`, `parseImprovedPrompt`, and `improvePrompt` are separate. |
| 2.4 caps 20 | closed | `MAX_ISSUES = 20`, `MAX_QUESTIONS = 20`, `MAX_OPTIONS = 3`; parser tests cover 21 inputs. |
| 2.5 score quick only | closed | `DeepReview` has no score; `ScoreReport` and `ScoreMeta` have no `source`; deep schema has no dimensions or confidence. |
| 2.6 explicit `@` files | closed | `prompt-files` replaces selection, active editor, and open editors; the source reads only referenced files and checks policy before reading. |
| 2.7 LSP agent tools | closed in code | `codeTools.ts` exposes the tools over LSP types; `vscodeCodeTools.ts` is the adapter; `ripgrep.ts` is the bundled fallback. |
| Review body: single-file defects | addressed | The fixes are scoped to the named files and their tests. |

## Owner requirements

| Requirement | Verdict | Evidence |
|---|---|---|
| Use the ripgrep library, not a system CLI | closed | `@vscode/ripgrep` dev dependency; build copies `rg` or `rg.exe` to `extension/dist`; no system `rg`. |
| Coexist with codebase access and fail over | closed | LSP tools try first; empty results with a query fall over to text search; hidden results never fall over; diagnostics never fall over. |
| Handoff covers concrete panel seams | closed | `docs/handoff/lane-1.md` has the delta table, contract deltas, panel seam calls, persistence shapes, and code tool calls. |
| Add tests, Windows, and real Codex events | closed | 527 tests; `path.win32` tests; real `item_completed` and `custom_tool_call` fixtures; e2e 11/11. |

## Findings from the adversarial pass

### Fixed

- The prompt-files source read a file before checking the policy. It now filters first and never opens an excluded file.
- `listFiles` fell back to text search when the primary list hid every path. It now stops, so hidden paths cannot reappear through `rg`.
- `canonicalFolderUri` left `#` and `?` as URI delimiters. It now percent-encodes them.
- A blank fallback query marked `textSearch: true` even though no search ran. It now omits `empty` without the marker.
- Windows duplicate references were compared case-sensitively. The resolver now lowercases the dedupe key when the path API is win32.
- UNC paths were dropped by `relativeToWorkspace`. They now use the injected path API and are tested with `path.win32`.
- `--disable-extensions` would have disabled the built-in TypeScript provider in e2e. The launcher no longer passes it; the extensions directory is empty.
- The Codex parser skipped `custom_tool_call` and `custom_tool_call_output` apply_patch events. It now records them, extracts every patch path, and dedupes the matching `FileChange`.

### Residual risks

- The e2e suite passed 11 of 11 tests after the E8 rg stdin fix. E11 covers the Codex custom tool call path.
- The live Windows run is not measured. Only `path.win32` unit tests run.
- Python and Rust LSP parity are manual.
- The legacy `Review`, `review()`, `parseReview`, and `LEGACY_DEEP_REPLY_SCHEMA` path remains until #46. New code does not use it.
- The panel is not wired to the new provider, context, session, or repository paths. #43, #46, and #47 own that integration.
- The #36 collectors and the #37 prompt-files adapter still have no direct VS Code mock test. The e2e suite is the coverage.

## Follow-up: Codex custom tool calls

- Trigger: an audit of 73 local Codex sessions found 359 `custom_tool_call` `apply_patch` events and 108 matching `FileChange` events.
- The parser had no branch for either event, so it dropped the calls and could miss changed files.
- Fix: parse `custom_tool_call` and `custom_tool_call_output`, extract every `*** Update|Add|Delete File:` path, use the call status as the failure hint, and dedupe the matching `FileChange` by id.
- Fixture: `extension/test/fixtures/codex/session-custom-tool.jsonl`.
- Tests: C35 and E11; `npm test` -> 527 passed; `npm run e2e` -> 11/11.
- Re-audit: 359 of 359 custom calls parsed; 2,799 unique tool calls; 0 duplicate FileChange calls.

## Gate status

- `npm run typecheck`: passed.
- `npm test`: 20 files, 527 tests passed.
- `npm run build`: passed; `extension/dist/rg` is 4.5 MB and reports ripgrep 15.0.0.
- `npm run e2e`: 11/11 passed on 2026-11-17.
- Final merge: PR #49 stays draft; the stacked fix PR is open for owner review.
