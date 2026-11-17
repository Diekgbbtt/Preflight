# PR #49 fix plan

**Source:** `docs/reviews/pr-49-feedback.md`
**Branch:** `lane-1/review-fixes`
**Base:** `lane-1/control-plane` at `363ea9f`
**Mode:** one work item at a time, red before green, no parallel implementers
**Final gate:** typecheck, unit and integration tests, build, e2e, adversarial review, handoff update, PR update

## 1. Goal

Close the seven PR review comments and the four owner requirements.
Keep the Lane 1 contracts coherent for lanes 2, 3, and 4.
Replace assumptions with measured or real-fixture behaviour.
Add an e2e tier that mounts the built extension in a real VS Code window.

## 2. Constraints

- Do not add `vscode-languageserver` or `vscode-languageclient`.
- Do not add a new service, settings service, or question service.
- Do not add speculative abstractions.
- Keep `core/` free of VS Code imports.
- Keep the single `hashPrompt`, the single `SendRecord`, and the single `DeepReview`.
- Do not duplicate the source ids, priorities, or privacy helpers.
- Do not change `main`.
- Do not merge the PR.
- The legacy prototype `Review` path stays working until #46 replaces it.
  - It is quarantined: no new fields, no new behaviour, and no new tests beyond keeping it green.
  - The new control-plane contracts do not depend on it.
  - The handoff names the exact replacement seam for #46.
- The shell has no network access.
  - The owner installed the LSP packages on 2026-11-17.
  - All other work starts immediately.

## 3. Work item order

### Phase 0 - Baseline and record

- Create the `lane-1/review-fixes` worktree.
- Record the review comments and owner answers in `docs/reviews/pr-49-feedback.md`.
- Confirm the baseline is green.
- Commit the record.

### Phase 1 - Core review schema, iteration 2

Goal: close comments 2.1 to 2.5.

#### Slice 1.1 - Provider-native thinking effort

- Red: a profile with `thinkingEffort: "xhigh"` builds `--effort xhigh`; `validateProfile` accepts it; an empty effort is rejected.
- Green:
  - `ThinkingEffort` becomes a provider-native `string`.
  - `ModelProfile`, `Config`, `ScoreReport`, and `ScoreMeta` carry `string`.
  - The Claude adapter passes the value through and validates only non-empty.
  - The VS Code setting becomes a string with `medium` as the default and examples in the description.
  - The activation probe keeps checking only for the `--effort` flag.
- Tests: `core/test/model.test.ts`, `core/test/claudeCli.test.ts`, `core/test/review.test.ts`, `extension/test/modelSettings.test.ts` if added.

#### Slice 1.2 - Raise the issue and question ceilings

- Red: 21 issues parse to 20; 21 quick questions parse to 20; 21 deep questions parse to 20; the 21st is dropped.
- Green:
  - `MAX_ISSUES = 20`.
  - `MAX_QUESTIONS = 20`.
  - `MAX_OPTIONS = 3` stays separate.
  - The reply schemas and prompt prose say 20.
- Tests: `core/test/review.test.ts`, `core/test/reviewCorpus.test.ts`.

#### Slice 1.3 - Remove the score from the deep review

- Red: a deep reply with dimensions produces a `DeepReview` with no score; `ScoreReport` has no `source` field; the deep schema has no dimensions or confidence.
- Green:
  - `DeepReview` has no `score`.
  - `parseDeepReview` does not call `parseScore`.
  - `DEEP_REPLY_SCHEMA` has no dimensions or confidence.
  - `ScoreReport` and `ScoreMeta` drop `source`; the quick path is the only score producer.
  - The legacy `review.ts` path keeps its own deprecated schema until #46.
- Tests: `core/test/review.test.ts`, `core/test/reviewCorpus.test.ts`, `core/test/review-corpus.jsonl`.

#### Slice 1.4 - Separate the improved prompt

- Red:
  - `DeepReview` has no `improvedPrompt`.
  - `parseDeepReview` ignores an `improvedPrompt` key.
  - `canImprove(deep)` is true only when `deep.questions.length > 0`.
  - `parseImprovedPrompt` returns the text, usage, latency, and prompt version.
  - `buildImprovedPromptRequest` includes the prompt, issues, questions, answers, and the placeholder instruction.
- Green:
  - Add `ImprovedPrompt`, `IMPROVE_REPLY_SCHEMA`, `parseImprovedPrompt`, `buildImprovedPromptRequest`, `canImprove`, and `improvePrompt`.
  - The improved request is a separate model call.
  - Unknown details are written as `[placeholders]`.
  - The deep request never asks for an improved prompt or a score.
- Tests: `core/test/improve.test.ts`, `core/test/review.test.ts`.

#### Slice 1.5 - Quarantine the legacy prototype path

- Keep `review.ts`'s `Review` and its legacy deep schema green.
- Rename its schema constant to `LEGACY_DEEP_REPLY_SCHEMA` and mark it deprecated.
- Record in the handoff that #46 replaces `Review`, `review()`, and `parseReview` with `QuickReview`, `DeepReview`, and `ImprovedPrompt`.
- Do not add the improved prompt to the new `DeepReview`.

#### Phase 1 commit

- Commit: `refactor(core): align review schema with the PR review (tickets #40, #39)`.
- Run typecheck, unit tests, and build.

### Phase 2 - Explicit `@` file context

Goal: close comment 2.6.

#### Slice 2.1 - Core source model

- Red: `SOURCE_PRIORITIES` has `prompt-files` at 80 and no `selection`, `active-editor`, or `open-editors`; `ContextKind` has `prompt-file` and not the three removed kinds.
- Green:
  - Update `ContextSourceId`, `ContextKind`, and `SOURCE_PRIORITIES`.
  - Update the assembler tests to use `prompt-files` and the remaining sources.
- Tests: `core/test/context.test.ts`.

#### Slice 2.2 - Privacy policy

- Red:
  - `IncludeCode` is `"off" | "prompt-files" | "workspace"`.
  - `IncludePolicy` carries `promptFiles?: string[]`.
  - `shouldInclude` admits a `prompt-file` only when it is referenced, non-empty, inside the workspace, and not excluded.
  - Under `prompt-files`, diagnostics and session code are admitted only for referenced paths.
  - A legacy `active-file` setting reads as `prompt-files`.
- Green: update `extension/src/privacy.ts`, the setting enum, and the settings reader.
- Tests: `extension/test/privacy.test.ts`.

#### Slice 2.3 - Pure `@` reference parser and resolver

- Red:
  - `findPromptFileRefs` finds `@src/foo.ts`, `@foo.ts`, `@./foo.ts`, and `@"path with spaces.ts"`.
  - It ignores email addresses, bare paths without `@`, duplicates, and trailing punctuation.
  - `resolvePromptFileRefs` resolves across multiple roots and reports missing and ambiguous refs.
- Green:
  - Add `core/src/promptFiles.ts` or extend `analyze.ts` with the pure parser.
  - Add `extension/src/promptFiles.ts` with the pure resolver.
  - Reuse `isOutsideWorkspace` and the exclusion predicate.
- Tests: `core/test/promptFiles.test.ts`, `extension/test/promptFiles.test.ts`.

#### Slice 2.4 - Prompt-files context source

- Red: the source reads each referenced file, deduplicates by resolved URI, applies the policy, records `files`, `dropped`, and `missing`, and omits `empty` when there are no refs.
- Green:
  - `createPromptFilesSource` in `extension/src/contextSources.ts`.
  - It reads the open document when one exists, else the file on disk.
  - It keeps one fragment per file, with the path and folder URI in provenance.
  - It never reads outside a root.
- Tests: pure parts in `extension/test/promptFiles.test.ts`; the thin adapter is covered by e2e because the lane forbids a broad VS Code mock.

#### Slice 2.5 - Session code policy

- Red: `SliceOptions` and `SessionSliceSourceDeps` use `promptFiles?: string[]` instead of `activeFileUri`; code excerpts are kept only for referenced paths under `prompt-files`.
- Green: update `extension/src/sessionSlice.ts` and the tests.
- Tests: `extension/test/sessionSlice.test.ts`.

#### Phase 2 commit

- Commit: `refactor(extension): replace implicit editor context with explicit @ files (tickets #36, #37, #41)`.
- Run typecheck, unit tests, and build.

### Phase 3 - Codex real format and Windows

Goal: close owner requirement 4.

#### Slice 3.1 - Real Codex fixtures

- Red: a fixture with `event_msg` + `item_completed` + `CommandExecution` yields one tool call with the real command, status, and output.
- Red: a fixture with `event_msg` + `item_completed` + `FileChange` yields changed files and one summary.
- Green:
  - Capture scrubbed fixtures from `~/.codex/sessions`.
  - Add them under `extension/test/fixtures/codex/`.
  - Keep the raw transcript out of the fixtures beyond the fields under test.
- Tests: `extension/test/sessionSlice.test.ts`.

#### Slice 3.2 - Real Codex parser

- Red: remove the `exec_command_begin` and `exec_command_end` assumption; parse `item_completed` for `CommandExecution` and `FileChange`.
- Green:
  - Map `status: "completed"` to ok, `"failed"` to error, unknown to unknown.
  - Use `aggregated_output` for the result text.
  - Use `changes` keys for changed files.
  - Do not double-count `AgentMessage` when `response_item` already carries the message.
- Tests: `extension/test/sessionSlice.test.ts`.

#### Slice 3.3 - Windows path handling

- Red:
  - `canonicalFolderUri` normalizes `file:///C:/Users/Alice/Proj`, UNC URIs, and trailing separators.
  - The Claude project encoding replaces every character outside `[A-Za-z0-9_-]` with `-`.
  - `relativeToWorkspace` handles drive-letter and backslash paths with `path.win32`.
  - `@` references resolve with `path.win32` and reject drive-letter escapes.
- Green:
  - Add the pure Windows-safe helpers.
  - Use the encoded folder name for discovery and matching.
  - Document that the live Windows run is a manual step.
- Tests: `extension/test/sessionLocator.test.ts`, `extension/test/sessionSlice.test.ts`, `extension/test/promptFiles.test.ts`, `docs/windows.md`.

#### Phase 3 commit

- Commit: `fix(extension): parse real Codex events and cover Windows paths (ticket #38)`.
- Run typecheck, unit tests, and build.

### Phase 4 - LSP agent middleware

Goal: close comment 2.7.
The owner installed the packages on 2026-11-17.

#### Slice 4.1 - Tool contracts over LSP types

- Red: a fake protocol returns LSP symbols, locations, and diagnostics; the tool layer caps them and reports `truncated`.
- Green:
  - `extension/src/codeTools.ts` (pure, no vscode).
  - Use `Position`, `Range`, `Location`, `LocationLink`, `SymbolInformation`, `DocumentSymbol`, `WorkspaceSymbol`, `Diagnostic`, and `SymbolKind` from `vscode-languageserver-types`.
  - Use `DocumentSymbolParams`, `WorkspaceSymbolParams`, `DefinitionParams`, `ReferenceParams`, and `DocumentDiagnosticParams` from `vscode-languageserver-protocol` at the adapter boundary.
  - Use `CancellationToken` from `vscode-jsonrpc` for cancellation.
  - Tools: `documentSymbols`, `workspaceSymbols`, `definitions`, `references`, `diagnostics`, `searchText`, `listFiles`.
- Tests: `extension/test/codeTools.test.ts`.

#### Slice 4.2 - Fallback orchestration

- Red: an empty LSP result with a query falls back to text search; a non-empty result never falls back; a policy-hidden result never falls back; a missing `rg` omits `unsupported`; an abort rejects with `cancelled`.
- Green:
  - The fallback keeps the source id and priority and marks `provenance.kind` as `text-search`.
  - Diagnostics has no text fallback.
  - `listFiles` falls back to `rg --files`.
- Tests: `extension/test/codeTools.test.ts`.

#### Slice 4.3 - Context sources on the tool layer

- Red: the symbol, workspace-symbol, definition, reference, and diagnostic sources call the tools, not the old `LanguageApi`.
- Green:
  - Update `extension/src/languageContext.ts` to use `CodebaseTools`.
  - Keep the fragment formatting, caps, and omission reasons.
  - Remove the duplicate `SearchFallbackOptions` and `LanguageApi` types.
- Tests: `extension/test/languageContext.test.ts`.

#### Slice 4.4 - VS Code adapter

- Red: the adapter converts VS Code symbols, locations, and diagnostics into LSP types; the ripgrep adapter parses `--json`; a missing binary maps to `ENOENT`.
- Green:
  - `extension/src/vscodeCodeTools.ts` is the only file that imports `vscode` for this layer.
  - It uses `vscode.commands.executeCommand` for the provider calls and `vscode.languages.getDiagnostics` for diagnostics.
  - It uses the injected `rgPath` for text search.
  - It keeps the per-document probe cache.
- Tests: `extension/test/vscodeCodeTools.test.ts` (thin adapter, allowed VS Code mock).

#### Slice 4.5 - Bundled ripgrep

- Red: the build copies the platform `rg` binary to `extension/dist/rg` (or `rg.exe`).
- Green:
  - Add `extension/scripts/copy-rg.mjs`.
  - Add `@vscode/ripgrep` as a dev dependency.
  - Update the extension build script.
  - The runtime resolves the binary from the extension path, not from `node_modules`.
- Verification: `npm run build` produces the binary; the e2e exercises a real search.

#### Slice 4.6 - Parity record

- Update `docs/lsp-parity.md` with the new tool names, the TypeScript e2e measurement, and the manual Python and Rust steps.
- Do not fabricate a provider result.

#### Phase 4 commit

- Commit: `refactor(extension): expose LSP-backed code tools with rg fallback (ticket #37)`.
- Run typecheck, unit tests, and build.

### Phase 5 - Handoff seams

Goal: close owner requirement 3.

- Rewrite the affected contracts in `docs/handoff/lane-1.md`:
  - #40 v2: effort string, caps 20, no deep score, no deep improved prompt, separate `ImprovedPrompt`.
  - #39 v1.2: provider-native effort string.
  - #36 v2: `prompt-files` source and `@` references.
  - #41 v2: `prompt-files` policy and the legacy `active-file` mapping.
  - #37 v2: `CodebaseTools` and the rg fallback.
  - #38 v2: real Codex `item_completed` format and Windows paths.
- Add a `Panel integration seams` section with:
  - A table of panel action -> seam -> input -> output -> persistence.
  - Exact calls for context assembly, quick review, deep review, improved prompt, session slicing, repositories, and code tools.
  - The exact event shapes for `drafts.jsonl`, `questions.jsonl`, `reviews.jsonl`, and `sends.jsonl`.
  - The #46/#47 replacement path for the legacy `Review`.
- Add a `Consumer map` for #43, #46, #47, #15, #27, #45, and #10.

### Phase 6 - Assertions catalogue

- Write `docs/assertions/lane-1.md` with the `/to-assertions` layout.
- Contract predicates cover:
  - Schema parsing and caps.
  - Effort pass-through.
  - Improved-prompt gating and parsing.
  - Privacy policy and redaction.
  - Repository envelopes and migration.
  - Context assembly and manifest.
  - `@` reference parsing and resolution.
  - Code tools and fallback.
  - Session parsing, caps, and locator precedence.
- Walkthrough predicates cover:
  - Draft with `@` files -> quick score -> manifest -> send record.
  - Deep review -> questions -> separate improved prompt -> persistence.
  - Consent off -> code excluded.
  - Claude session slice with prompt-files code policy.
  - Codex real event slice.
  - TypeScript language tools and rg fallback.
  - Windows path unit walkthrough.
- Present the catalogue to the owner for approval before mechanising the e2e tier.

### Phase 7 - E2E harness

- Add `e2e/` with:
  - `e2e/run.mjs`: builds the extension and suite, creates temp user-data and extensions dirs, launches the local VS Code binary with `--extensionDevelopmentPath`, `--extensionTestsPath`, `--user-data-dir`, `--extensions-dir`, `--disable-extensions`, and `--disable-gpu`.
  - `e2e/suite/index.ts`: the extension-host test module.
  - `e2e/facade.ts`: the test facade that imports the new control-plane modules and wires real VS Code APIs.
  - `e2e/fixtures/`: the sample workspace, fake Claude CLI, and seeded session files.
- Add `npm run e2e`.
- Mechanise every approved walkthrough predicate.
- Assert terminal quantities from the live JSONL files and the real VS Code language providers.
- Declare the live edge:
  - Model provider: fake Claude CLI.
  - Language server: the built-in TypeScript extension.
  - File system: the temp fixture workspace.
- Exit nonzero on any failure.

### Phase 8 - Adversarial review and final gate

- Review the diff against:
  - The seven comments.
  - The four owner requirements.
  - The no-duplicate rule for hash, source, helper, and schema.
  - The privacy boundary.
  - The lane boundaries.
  - Over-engineering and type modelling.
- Fix every finding.
- Run `npm run typecheck && npm test && npm run build`.
- Run `npm run e2e`.
- Run the full suite three times.
- Update the handoff ledger and the assertions catalogue with the final test names.
- Commit and fast-forward `lane-1/control-plane`.
- Push and update PR #49.
- Do not merge.

## 4. Files expected to change

- `core/src/schema.ts`
- `core/src/model.ts`
- `core/src/claudeCli.ts`
- `core/src/context.ts`
- `core/src/review.ts`
- `core/src/promptFiles.ts` (new)
- `core/src/index.ts`
- `core/test/*`
- `extension/src/privacy.ts`
- `extension/src/contextSources.ts`
- `extension/src/promptFiles.ts` (new)
- `extension/src/languageContext.ts`
- `extension/src/codeTools.ts` (new)
- `extension/src/vscodeCodeTools.ts`
- `extension/src/sessionSlice.ts`
- `extension/src/sessionLocator.ts`
- `extension/src/modelSettings.ts`
- `extension/src/exec.ts`
- `extension/scripts/copy-rg.mjs` (new)
- `extension/package.json`
- `extension/test/*`
- `extension/test/fixtures/codex/*`
- `docs/handoff/lane-1.md`
- `docs/lsp-parity.md`
- `docs/windows.md` (new)
- `docs/assertions/lane-1.md` (new)
- `e2e/*` (new)
- `package.json`

## 5. Test tiers

- Unit: Vitest, pure modules, fake ports, temp directories.
- Integration: Vitest, real JSONL files, real git commands, real fixture files.
- E2E: the built extension in the local VS Code extension host.
- The unit and integration tiers never select the e2e tier.
- The e2e tier runs once at the verification gate.

## 6. Dependency order

1. Phase 1 (core) before Phase 2 (context) because the context sources consume the schema types.
2. Phase 2 (privacy and prompt files) before Phase 3 (session code policy).
3. Phase 3 (Codex and Windows) before Phase 7 (e2e fixtures).
4. Phase 4 (LSP) after the owner install and before Phase 5 (handoff) because the handoff records the final tool contract.
5. Phase 5 before Phase 6 so the assertions cite final seams.
6. Phase 6 approval before Phase 7.
7. Phase 8 last.

## 7. Checkpoints

- After each phase: typecheck, unit tests, build, and a short owner-visible result.
- After Phase 1: review the new schema against comments 2.1 to 2.5.
- After Phase 2: review the `@` context semantics against comment 2.6.
- After Phase 3: review the real Codex fixtures and Windows tests.
- After Phase 4: review the LSP tool contract against comment 2.7.
- After Phase 6: owner approves the assertions catalogue.
- After Phase 8: owner sees the final gate and the updated PR.

## 8. Owner action taken

The shell cannot reach the npm registry.
The owner installed these packages on 2026-11-17:

```bash
npm install -w extension vscode-languageserver-types@3.18.5 vscode-languageserver-protocol@3.18.5 vscode-jsonrpc@10.0.0
npm install -w extension --save-dev @vscode/ripgrep@1.18.0
```

`@vscode/ripgrep` is a build-time dependency.
The build copies the platform binary into `extension/dist/`.
The runtime does not import the ESM package.

## Status (2026-11-17)

| Phase | State | Evidence |
|---|---|---|
| 0 Review record and plan | done | `docs/reviews/pr-49-feedback.md`, this file |
| 1 Core review schema | done | 20 test files, 524 tests; typecheck and build green |
| 2 Explicit `@` file context | done | prompt-files source, privacy policy, session code policy |
| 3 Codex real events and Windows | done | real `item_completed` fixtures; `path.win32` tests |
| 4 LSP agent middleware | done | `codeTools.ts`, `vscodeCodeTools.ts`, `ripgrep.ts`; 26 tool tests, 11 adapter tests, 10 ripgrep tests |
| 5 Handoff seams | done | contract deltas and `Panel integration seams` in `docs/handoff/lane-1.md` |
| 6 Assertions catalogue | approved | `docs/assertions/lane-1.md` |
| 7 E2E harness | first run 8/9; rerun pending | `e2e/` builds; E1-E7 and E9 passed; E8 failed on rg stdin and is fixed |
| 8 Adversarial review and final gate | pending | adversarial review done; blocked on the e2e rerun |

### Current commits

- `97968f7` review record and plan
- `be6faa0` schema and effort fixes
- `4eb8a77` explicit `@` file context
- `723ca64` real Codex events and Windows paths
- `fd00206` assertion catalogue and panel seams
- `1f8d17c` LSP-backed code tools with rg fallback
- `ba0edb3` skip reads for excluded prompt files
- `e200604` VS Code e2e harness
- `41691fc` review contract deltas and e2e harness

### E2E status

- The owner ran `npm run e2e` in a normal GUI Terminal.
- E1, E2, E3, E4, E5, E6, E7, and E9 passed.
- E8 failed because `rg` read stdin instead of the workspace when no path was given.
- The adapter now passes an explicit `.` search path, and the parser strips a leading `./`.
- The E8 path was reproduced with the real binary and the tool layer: it returns `src/needle.ts`.
- A rerun is pending.
- `node e2e/run.mjs --dry-run` prints the exact launch command.
