# Lane 1 handoff ledger

The ledger is the only cross-ticket memory for Lane 1.
It is authoritative for consumers in lanes 2, 3, and 4.
Every entry has a contract version and a change log.

## Status

| Ticket | State | Branch | Commit | Tests | Reviewer |
|---|---|---|---|---|---|
| #40 | merged | ticket/40-review-schema | cf5cdbbcacbb73468dc8b8c0d90eb41eb59bc622 | `npm run typecheck && npm test && npm run build` -> 111 passed | PASS |
| #41 | merged | ticket/41-privacy-policy | bf2bb83575f7007a9537c5802e5146587990fcc0 | `npm run typecheck && npm test && npm run build` -> 151 passed | PASS |
| #35 | merged | ticket/35-jsonl-repository | 621906d336f7aaaf7d68165a11a01a1d15d52a4e | `npm run typecheck && npm test && npm run build` -> 187 passed | PASS |
| #39 | merged | ticket/39-model-profiles | 986b610b2f5bf0ee0b18a3a803c51771fee789ff | `npm run typecheck && npm test && npm run build` -> 227 passed | PASS |
| #42 | merged | ticket/42-feedback-errors | 507ee22d48d26de29a5cf3e88982040105b40e65 | `npm run typecheck && npm test && npm run build` -> 295 passed | PASS |
| #36 | merged | ticket/36-context-assembler | 495b52853631580933232fea1a3941c94adb5510 | `npm run typecheck && npm test && npm run build` -> 322 passed | PASS |
| #37 | merged | ticket/37-language-context | 96ce4605b489049d8c6919c8bcbd429ff2cc66f3 | `npm run typecheck && npm test && npm run build` -> 442 passed | PASS |
| #38 | merged | ticket/38-session-slice | e366d25df10a700bae886d3af3d342afe959455d | `npm run typecheck && npm test && npm run build` -> 518 passed | PASS |
| Review fixes | merged | lane-1/control-plane | review-fixes tip | `npm run typecheck && npm test && npm run build` -> 524 passed three times; `npm run e2e` -> 9/9 passed | PASS |

The review fixes are merged into `lane-1/control-plane` locally.
The e2e gate is green: 9/9 passed on 2026-11-17.

Source branch: `lane-1/control-plane`.
Setup commit: `098e887` (`chore: set up lane 1 worktrees and extension tests`).
Lane base for ticket #40: `098e8873371ef995ba7cb1a2ddbd50a2bc385a03`.
Lane base for ticket #41: `9ed943f7e352c4c56653ed5e003607a3d79d2a34`.
Lane base for ticket #35: `6b1384bc0453247d9d2212a16b9bcc7f77a9077c`.
Lane base for ticket #39: `ed0c1d7cb40aee3fe68e633d75b2896839ae124b`.
Lane base for ticket #42: `35c6a3b`.
Lane base for ticket #36: `0c62960`.
Lane base for ticket #37: `99b7392`.
Lane base for ticket #38: `d34bd22`.

## PR #49 review deltas

| Area | Old contract | New contract |
|---|---|---|
| Thinking effort | `"low" \| "medium" \| "high"` | Provider-native `string`, passed to `--effort` unchanged |
| Issue ceiling | 3 | 20 |
| Question ceiling | 3 | 20 |
| Deep score | `DeepReview.score` | Removed; score is quick-only and asynchronous |
| Deep improved prompt | `DeepReview.improvedPrompt` | Removed; separate `ImprovedPrompt` action |
| Improved prompt trigger | Always present in the deep reply | Enabled only after a deep review with at least one question |
| Active editor, selection, open editors | First-class context sources | Removed; explicit `@` file references only |
| Context source | `selection` 80, `active-editor` 70, `open-editors` 60 | `prompt-files` 80 |
| Include code | `off \| active-file \| workspace` | `off \| prompt-files \| workspace`; legacy `active-file` reads as `prompt-files` |
| Language access | Bespoke `LanguageApi` over `vscode.commands` | Agent tools over LSP types with a text-search fallback |
| Codex events | Assumed `exec_command_begin` / `exec_command_end` | Real `event_msg.item_completed` `CommandExecution` and `FileChange` |
| Windows | Recorded gap | Pure `path.win32` rules plus a manual Windows checklist |

## Contract deltas in detail

These sections supersede the matching fields in the per-ticket contracts below.
When this document conflicts with a per-ticket section, this section wins.

### #40 Review schema - v2

- `ScoreReport` fields: `dimensions`, `score`, `level`, `provider`, `model`, `thinkingEffort: string`, `rubricVersion`, `promptHash`, `scoredAt`, `confidence?`.
- `ScoreReport` has no `source` field. The quick path is the only score producer.
- `ScoreMeta` fields: `provider`, `model`, `thinkingEffort: string`, `scoredAt`.
- `QuickReview` fields: `score: ScoreReport | null`, `issues`, `questions`.
- `DeepReview` fields: `issues`, `questions`, `assumptions`, `contextGaps`, `usage`, `latency`, `promptVersion`.
- `DeepReview` has no `score` and no `improvedPrompt`.
- `ImprovedPrompt` fields: `text`, `usage`, `latency`, `promptVersion`.
- `IMPROVE_PROMPT_VERSION = "v1"`.
- `IMPROVE_REPLY_SCHEMA` is the separate rewrite schema.
- `parseImprovedPrompt(text, usage, latency)` returns `ImprovedPrompt | null`.
- `canImprove(review)` is true only when `review.questions.length > 0`.
- `buildImprovedPromptRequest(prompt, review, qa, model)` includes the prompt, issues, questions, answers, assumptions, gaps, and the placeholder instruction. It never includes the rubric.
- `improvePrompt(prompt, review, qa, run, model, clock, signal?)` returns `ImprovedPrompt | null`. It does not call the model when `canImprove` is false.
- `MAX_ISSUES = 20`, `MAX_QUESTIONS = 20`, `MAX_OPTIONS = 3`.
- `LEGACY_DEEP_REPLY_SCHEMA` in `review.ts` is deprecated. #46 removes it with the legacy `Review` path.

### #39 Model provider profiles - v1.2

- `ThinkingEffort` is a provider-native `string`.
- `Config.thinkingEffort` is a `string`.
- The setting `promptPreflight.thinkingEffort` is a string with default `medium`.
- Claude Code accepts `low`, `medium`, `high`, `xhigh`, and `max`; these are examples, not an enforced union.
- `validateClaudeProfile` rejects only an empty effort.
- `buildClaudeArgs` passes the value to `--effort` unchanged.
- The activation probe still checks only whether the CLI exposes `--effort`.

### #36 Context assembler - v2

- `ContextKind` is `prompt-file | git-diff | test-command | diagnostic | symbol | reference | definition | workspace-symbol | text-search | session`.
- `ContextSourceId` is `draft | qa | session-slice | prompt-files | git-diff | diagnostics | symbols | references | definitions | workspace-symbols | test-command`.
- `SOURCE_PRIORITIES`: `prompt-files` 80, `git-diff` 50, `diagnostics` 45, `symbols` 40, `references` 39, `definitions` 38, `workspace-symbols` 37, `test-command` 30.
- `selection`, `active-editor`, and `open-editors` are removed.
- `findPromptFileRefs(text)` returns unique `PromptFileRef` records in prompt order. It accepts `@src/a.ts`, `@./src/a.ts`, `@src\\a.ts`, and quoted paths with spaces. It ignores emails, decorators, npm scopes without an extension, bare paths, and directories.
- `resolvePromptFileRefs(refs, roots, exists, pathApi?)` resolves across roots. It reports `missing`, `outside`, `ambiguous`, and `duplicate`; an ambiguous reference is never guessed.
- `buildPromptFilesResult(input)` reads only allowed files. It counts `files`, `dropped`, `missing`, `ambiguous`, `excluded`, `duplicate`, and `unreadable`.
- `createPromptFilesSource({ folders, policy, draft, readText? })` is the only prompt-file collector.
- The source checks policy before reading. An excluded file is never opened.
- `git-diff` and `test-command` remain.

### #41 Privacy and consent - v2

- `IncludeCode = "off" | "prompt-files" | "workspace"`.
- `IncludeKind = "prompt-file" | "workspace" | "diagnostic" | "session"`.
- `IncludePolicy = { includeCode: IncludeCode; promptFiles?: string[] }`.
- `shouldInclude(path, kind, policy)` returns false under `off`.
- Under `prompt-files`, only a path in `policy.promptFiles` is included.
- Under `workspace`, every non-excluded, non-empty, workspace-relative path is included.
- The exclusion list and the workspace boundary always win.
- `parseIncludeCode(value)` maps `active-file` to `prompt-files`; it maps an unknown value to `off`.
- The setting enum is `off | prompt-files | workspace`; the default is `prompt-files`.
- `consentedIncludeCode` is unchanged: no accepted consent means `off`.
- `redact`, `EXCLUDE_GLOB`, `consentMessage`, and `SourcePrivacyFields` are unchanged.

### #37 Language context - v2

- `extension/src/codeTools.ts` is the agent tool layer.
- Exports: `CODE_TOOL_CAPS`, `createCodeTools`, `withTimeout`, `LanguageProtocol`, `TextSearchPort`, `CodebaseTools`, `ToolResult`, `FallbackResult`, `ToolSymbol`, `ToolLocation`, `ToolDiagnostic`, `TextSearchMatch`.
- Tools: `documentSymbols`, `workspaceSymbols`, `definitions`, `references`, `diagnostics`, `searchText`, `listFiles`.
- Caps: 100 document symbols, 50 workspace symbols, 20 definitions, 50 references, 200 diagnostics, 50 text matches, 200 files.
- LSP-backed tools try the language provider first.
- An empty LSP result with a query falls back to text search.
- A policy-hidden result never falls back.
- Diagnostics never fall back.
- A missing bundled `rg` omits `unsupported`.
- `LanguageProtocol` uses LSP types and request params from `vscode-languageserver-protocol`; cancellation uses `vscode-jsonrpc`.
- `createVscodeCodeTools({ cwd, rgPath, runRipgrep? })` implements `LanguageProtocol & TextSearchPort`.
- The adapter maps VS Code `SymbolKind` and `DiagnosticSeverity` names to LSP numeric values.
- `ripgrep.ts` exports `runRipgrep`, `parseRipgrepJson`, `parseRipgrepFiles`, and `bundledRipgrepPath`.
- The build copies the platform binary to `extension/dist/rg` or `extension/dist/rg.exe`.
- `@vscode/ripgrep` is a dev dependency. There is no system `rg` requirement.
- `LanguageSourceDeps` is `{ tools, policy, folderUri?, activePath?, activePosition?, openDocuments?, query? }`.
- The five sources are `diagnostics`, `symbols`, `workspace-symbols`, `definitions`, and `references`.
- `LanguageApi`, `probeCapabilities`, `searchFallback`, and the old `rg` helper are removed.

### #38 Current session slice - v2

- Codex `event_msg` parsing uses `item_completed` with `CommandExecution` and `FileChange`.
- `CommandExecution` fields: `id`, `command` array, `cwd`, `status`, `aggregated_output`, `exit_code`.
- `FileChange` fields: `id`, `changes` map, `status`, `stdout`.
- A `function_call` and a `CommandExecution` with the same `id` produce one tool call, not two.
- `AgentMessage` is skipped because it duplicates the `response_item` message.
- `exec_command_begin` and `exec_command_end` are removed.
- `function_call` arguments support `cmd` as well as `command`.
- `canonicalFolderUri` normalizes POSIX, Windows drive, UNC, localhost, trailing slash, and malformed URIs.
- `encodeClaudeProjectPath(cwd)` replaces every character outside `[A-Za-z0-9_-]` with `-`.
- `relativeToWorkspace(raw, cwd, pathApi?)` accepts an injected path API; `path.win32` is tested.
- The real fixtures are `extension/test/fixtures/codex/session-real-events.jsonl` and `session-basic.jsonl`.
- The fake `session-exec-events.jsonl` fixture is deleted.
- The live Windows run is a manual step in `docs/windows.md`.

## Panel integration seams

This section is the concrete wiring contract for #43, #46, #47, and #15.
It names the calls the panel makes, the exact inputs and outputs, and the persistence.
The panel must not read the raw transcript, duplicate the prompt hash, or build a second source id.

### Shared composition

```ts
const config = readModelConfig();
const profile = resolveProfile(config, mode);
const provider = createProvider(profile, config);
const run = claudeCliRunner(config.claudePath, workspaceRoot, profile.thinkingEffort);
const consent = parseConsent(context.globalState.get(consentKey(CONSENT_VERSION)));
const includeCode = consentedIncludeCode(configIncludeCode, consent);
```

- `profile.thinkingEffort` is a provider-native string.
- `provider.capabilities` supplies the context budget and the session token cap.
- `run` keeps the workspace cwd; `provider.complete` is the long-term provider path.

### Draft input to context bundle

```ts
const refs = findPromptFileRefs(draft).map((ref) => ref.text);
const policy: IncludePolicy = { includeCode, promptFiles: resolvedPaths };
const sources: ContextSource[] = [
  createPromptFilesSource({ folders, policy, draft, readText }),
  createGitDiffSource({ folder, policy }),
  createTestCommandSource({ folder, policy }),
  ...createLanguageSources({ api, policy, folderUri, cwd, query, probe }),
  createSessionSliceSource({
    folderUri,
    sends,
    promptHash,
    clock,
    capabilities: provider.capabilities,
    includeCode: policy.includeCode,
    promptFiles: policy.promptFiles,
    redact,
  }),
];
const bundle = await assemble({ draft, qa }, sources, {
  budget: provider.capabilities.maxContextTokens,
  estimateTokens,
  redact,
  signal,
});
```

- `folders` is `vscode.workspace.workspaceFolders ?? []`.
- `resolvedPaths` comes from `resolvePromptFileRefs`; the same list feeds the policy for diagnostics and session code.
- The panel passes `draft` to the prompt-files source; the source parses the same `@` references.
- `bundle.manifest` is the only source of included, truncated, omitted, and redaction facts.
- The panel never reads `vscode.window.activeTextEditor` to build context.

### Quick review

```ts
const request = buildReviewRequest(draft, "quick", profile.model, { analysis, projectNotes });
const res = await run(request, signal);
const quick = parseQuickReview(res.text, draft, {
  provider: profile.provider,
  model: profile.model,
  thinkingEffort: profile.thinkingEffort,
  scoredAt: new Date().toISOString(),
});
```

- `quick.score` is the only score source.
- `quick.score` has no `source` field.
- `quick.issues` and `quick.questions` are capped at 20.

### Deep review

```ts
const request = buildDeepReviewRequest(bundle, profile.model); // #46 owns the prose
const res = await run(request, signal);
const deep = parseDeepReview(res.text, draft, {
  usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd },
  latency,
});
```

- `#46` builds the deep request from `RUBRIC_TEXT` and `DEEP_REPLY_SCHEMA`.
- The deep request never asks for dimensions, confidence, or an improved prompt.
- `deep` has `issues`, `questions`, `assumptions`, `contextGaps`, `usage`, `latency`, and `promptVersion`.
- `deep` has no `score` and no `improvedPrompt`.

### Separate improved prompt

```ts
if (canImprove(deep)) {
  const improved = await improvePrompt(draft, deep, qa, run, profile.model, { now: Date.now });
  if (improved) panel.showImprovedPrompt(improved.text);
}
```

- The action is disabled while `canImprove(deep)` is false.
- The request includes the original prompt, issues, questions, answers, assumptions, and context gaps.
- Unanswered details stay as `[placeholders]`.
- `improved` has `text`, `usage`, `latency`, and `promptVersion`.
- The improved prompt is never stored inside the deep review event.

### Session slice

```ts
const source = createSessionSliceSource({
  folderUri,
  sends,
  promptHash,
  clock,
  capabilities: provider.capabilities,
  includeCode: policy.includeCode,
  promptFiles: policy.promptFiles,
  redact,
});
```

- `locateSession` returns `found`, `ambiguous`, or `none`.
- The panel shows the picker for `ambiguous`; the source never guesses.
- `readSlice` keeps code only for `prompt-files` references under `prompt-files`.
- The raw transcript never leaves the reader.

### Persistence

```ts
await drafts.append({ id: draftId, ts: nowIso(), text: draft, folderUri });
await questions.append({ id: questionId, ts: nowIso(), draftId, sessionId, ...question });
await reviews.append({ id: reviewId, ts: nowIso(), draftId, sessionId, ...deep, sessionSlice });
await sends.append({
  id: sendId,
  ts: nowIso(),
  draftId,
  folderUri,
  text: draft,
  promptHash: hashPrompt(draft),
  sessionId,
  target,
});
```

- `sends.jsonl` stores the only exact sent prompt copy.
- `reviews.jsonl` stores the deep review plus the derived session slice.
- There is no `slices.jsonl`.
- `questions.jsonl` payload fields are owned by #15.
- `drafts.jsonl` payload has at least `text` and `folderUri`.
- `byDraft` matches the envelope `id` for drafts and the payload `draftId` for the other files.
- `bySession` matches the payload `sessionId`.

### Code tools

```ts
const tools = createCodeTools({ protocol: vscodeCodeProtocol, textSearch: ripgrepTextSearch, policy });
const symbols = await tools.documentSymbols({ path: "src/greet.ts" });
const refs = await tools.references({ path: "src/greet.ts", position: { line: 4, character: 10 } });
const matches = await tools.searchText({ query: "greet", maxResults: 50 });
```

- Every tool is read-only.
- LSP-backed tools try the language provider first.
- A tool with a query falls back to text search when the provider returns no data.
- Diagnostics never fall back to text search.
- The bundled `rg` binary is resolved from the extension path.

### Legacy path

- `Review`, `review()`, `parseReview`, and `LEGACY_DEEP_REPLY_SCHEMA` are the prototype path.
- They stay green until #46 replaces the panel.
- New consumers must not import them.
- #46 removes them when the panel uses `QuickReview`, `DeepReview`, and `ImprovedPrompt`.

<a id="contract-40"></a>

## Contract: #40 Review schema and rubric versioning - v1

> **Superseded in v2:** the fields and seams in "Contract deltas in detail" win.
> The text below is retained as the v1 record.


- State: merged.
- Commit: `cf5cdbbcacbb73468dc8b8c0d90eb41eb59bc622`.
- Exports:
  - `interface RuleReport { findings: Finding[]; questions: string[]; skipped: boolean; hardBlock: boolean }`
  - `interface Analysis extends RuleReport { level: Level; score: number; dimensions: Dimensions; shouldClarify: boolean }`
  - `interface ScoreReport { dimensions: Dimensions; score: number; level: Level; source: "quick" | "deep"; provider: string; model: string; thinkingEffort: "low" | "medium" | "high"; rubricVersion: string; promptHash: string; scoredAt: string; confidence?: number }`
  - `interface ScoreMeta { source: "quick" | "deep"; provider: string; model: string; thinkingEffort: "low" | "medium" | "high"; scoredAt: string }`
  - `interface QuickReview { score: ScoreReport | null; issues: ReviewIssue[]; questions: string[] }`
  - `type ModelUsage = Pick<ModelResponse, "inputTokens" | "outputTokens" | "costUsd">`
  - `interface DeepQuestion { question: string; why: string; options: string[] }`
  - `interface DeepReview { score: ScoreReport | null; issues: ReviewIssue[]; questions: DeepQuestion[]; improvedPrompt: string; assumptions: string[]; contextGaps: string[]; usage: ModelUsage; latency: number; promptVersion: string }`
  - `const RUBRIC_TEXT: string`
  - `const QUICK_REPLY_SCHEMA: string`
  - `const DEEP_REPLY_SCHEMA: string`
  - `const RUBRIC_VERSION = "v1"`
  - `const PROMPT_VERSION = "v1"`
  - `function hashPrompt(text: string): string`
  - `function levelForScore(score: number): Level`
  - `function parseScore(text: string, prompt: string, meta: ScoreMeta): ScoreReport | null`
  - `function parseQuickReview(text: string, prompt: string, meta: ScoreMeta): QuickReview`
  - `function parseDeepReview(text: string, prompt: string, meta: ScoreMeta & { usage: ModelUsage; latency: number }): DeepReview`
  - `function extractJson(text: string): unknown`
- Fields:
  - `ScoreReport.score`: `number`, 0-100, the sum of the four dimensions. Never clamped.
  - `ScoreReport.dimensions`: `Dimensions`, each of `target`, `action`, `scope`, `done` is 0-25 in steps of 5.
  - `ScoreReport.level`: `Level`, derived only by `levelForScore`.
  - `ScoreReport.source`: `"quick" | "deep"`, injected by the caller.
  - `ScoreReport.provider`: `string`, injected by the caller.
  - `ScoreReport.model`: `string`, injected by the caller.
  - `ScoreReport.thinkingEffort`: `"low" | "medium" | "high"`, injected by the caller. This is the inline union that #39's named `ThinkingEffort` must match.
  - `ScoreReport.rubricVersion`: `string`, `RUBRIC_VERSION`.
  - `ScoreReport.promptHash`: `string`, lowercase SHA-256 hex of the normalized prompt.
  - `ScoreReport.scoredAt`: `string`, ISO 8601, supplied in `ScoreMeta`. Parsers do not call a clock.
  - `ScoreReport.confidence`: `number | undefined`, 0-1, only when the model supplied a finite number in range.
  - `QuickReview.issues` and `DeepReview.issues`: `ReviewIssue[]`, at most 3.
  - `QuickReview.questions`: `string[]`, at most 3.
  - `DeepReview.questions`: `DeepQuestion[]`, at most 3. Each has at most 3 string options.
  - `DeepReview.usage`: `ModelUsage`, the injected token and cost fields.
  - `DeepReview.latency`: `number`, milliseconds, injected.
  - `DeepReview.promptVersion`: `string`, `PROMPT_VERSION`.
  - `RuleReport.hardBlock`: `boolean`, true when at least one finding has severity `error`.
- Invariants:
  - `hashPrompt(text)` is SHA-256 hex of `text.trim().replace(/\r\n/g, "\n")` with internal whitespace kept. There is no second normalization.
  - The four dimensions must be present, finite integers, multiples of 5, in range 0 to 25. Extra dimension keys are ignored.
  - The model total is ignored. The score is always the dimension sum.
  - The model verdict is ignored. `ScoreReport` has no verdict field.
  - `levelForScore(score)` is the only implementation of the thresholds: 80 or more is `clear`, 55 or more is `needs-work`, otherwise `vague`. `analyze()` uses the same helper.
  - Rubric anchors exist for 0, 5, 10, 15, 20, and 25 for each dimension. `RUBRIC_TEXT` is the only rubric copy and is used by both quick and deep.
  - `buildReviewRequest` includes `RUBRIC_TEXT` and the mode reply schema once in the system prompt. The rubric stays out of the user message.
  - `extractJson` is the only tolerant JSON reader. Two JSON objects in one reply are invalid and are never merged.
  - `Analysis` keeps `level`, `score`, `dimensions`, and `shouldClarify`. `hardBlock` is additive.
  - `Review`, `review()`, `parseReview`, and `buildReviewRequest` keep their existing public behavior.
- Errors:
  - `parseScore` returns `null` on malformed JSON, a missing or invalid dimension, or a non-object reply. It never throws.
  - `parseQuickReview` returns `{ score: null, issues: [], questions: [] }` on malformed JSON. If the JSON is valid but the dimensions are invalid, the score is `null` and the parseable issues and questions are kept.
  - `parseDeepReview` returns `score: null`, empty issues and questions, `improvedPrompt: ""`, empty `assumptions` and `contextGaps`, and the injected `usage` and `latency` on malformed JSON. If the JSON is valid but the dimensions are invalid, the score is `null` and the other fields are kept.
  - A quote that is not a substring of the prompt is dropped from the issue. The issue remains without a quote or range.
  - Issues are capped at 3. Quick questions are capped at 3. Deep questions and their options are capped at 3.
- Persistence:
  - None in this ticket. #35 owns JSONL persistence.
- Privacy:
  - No prompt text is stored by this contract. `promptHash` is a hash only.
  - Parsers do not log prompt text, scores, or raw model output.
- Tests:
  - `core/test/review.test.ts`: `npx vitest run core/test/review.test.ts` -> 41 passed.
  - `core/test/reviewCorpus.test.ts`: `npx vitest run core/test/reviewCorpus.test.ts` -> 23 passed.
  - Full suite: `npm test` -> 111 passed.
- Test seams:
  - `parseScore`: `core/test/review.test.ts`.
  - `parseQuickReview`: `core/test/review.test.ts`.
  - `parseDeepReview`: `core/test/review.test.ts`.
  - `parseReview`: `core/test/review.test.ts`.
  - `buildReviewRequest` for the rubric and reply-schema sections: `core/test/review.test.ts`.
  - `hashPrompt` with four independent known SHA-256 vectors: `core/test/review.test.ts`.
  - Rubric anchors and reply-schema snapshots: `core/test/review.test.ts`.
  - `analyze()` `hardBlock`: `core/test/review.test.ts`.
  - Corpus file: `core/test/reviewCorpus.test.ts`.
- Edge modes covered:
  - Invalid dimension: missing, string number, float, NaN, negative, out of range, not a multiple of 5, array, missing dimensions object, two JSON objects, malformed JSON. Result: no score, no crash.
  - Valid boundary scores: 0 and 100. Result: accepted, never clamped.
  - Model total and verdict disagree with the sum. Result: the dimension sum wins.
  - Extra dimension key. Result: ignored.
  - Quote not in the prompt. Result: quote and range dropped, issue kept.
  - Duplicate quotes. Result: both issues kept, capped at 3.
  - Fenced JSON, leading prose, trailing prose. Result: parsed.
  - Injection text inside `<prompt>` and a non-English prompt. Result: treated as data, normal parse.
  - Deep reply with missing improvedPrompt, assumptions, contextGaps, questions, or options. Result: safe defaults.
- Assumptions:
  - `ScoreReport.thinkingEffort` is the inline union `"low" | "medium" | "high"`. #39 must export a named `ThinkingEffort` that is structurally identical and must not change these values.
  - `assumptions` and `contextGaps` have no cap in the ticket, so they keep every string.
  - Non-string `problem` and `suggestion` values are coerced with `String()`, matching the existing `parseReview` tolerance. A problem that coerces to empty drops the issue.
  - `QuickReview.score === null` carries no `rubricVersion`. The version is recorded on every `ScoreReport` and on every `DeepReview.promptVersion`.
  - The reply schemas no longer request a `verdict`. `parseReview` still defaults a missing verdict to `needs-work`; no current consumer reads it.
  - `extractJson` lives in `core/src/schema.ts` so `schema.ts` is a leaf module. `core/src/review.ts` re-exports it; the public core path is unchanged.
- Consumers:
  - #26: consume `parseQuickReview`, `RUBRIC_TEXT`, `QUICK_REPLY_SCHEMA`, and `PROMPT_VERSION`. #26 owns the quick prompt prose and bumps `PROMPT_VERSION` when that prose changes.
  - #27: consume `ScoreReport`, `levelForScore`, and `hashPrompt`. #27 removes the rule score from `Analysis`.
  - #35: consume `DeepReview`, `ScoreReport`, `hashPrompt`, `RUBRIC_VERSION`, and `PROMPT_VERSION`. Store the `DeepReview` plus the derived `SessionSlice`.
  - #36: consume the version constant naming convention only. Do not import the review parser.
  - #38: consume `hashPrompt` for the send-path hash. Do not reimplement SHA-256 or the normalization.
  - #39: align `ModelProfile` and the named `ThinkingEffort` with `ScoreReport` field names and the inline union.
  - #42: consume `ScoreReport` for degraded modes and error state.
  - #45: consume `hashPrompt` and the version constants for study-log v2.
  - #13: consume `parseDeepReview`, `RUBRIC_TEXT`, `DEEP_REPLY_SCHEMA`, and `PROMPT_VERSION`. #13 owns the deep prompt prose.
  - #46: extend `DeepReview` with `contextManifest: ContextManifest` after #36 merges. #40 does not add it.
- Open gaps:
  - None for this contract. #46 owns the `DeepReview.contextManifest` extension.
  - `QuickReview` has no version field of its own when the score is null. This matches the published shape; consumers must treat the absence of a score as "no current score".
- Change log:
  - v1: initial contract merged in #40.

<a id="contract-41"></a>

## Contract: #41 Privacy and consent boundary - v1.1

> **Superseded in v2:** the fields and seams in "Contract deltas in detail" win.
> The text below is retained as the v1 record.


- State: merged.
- Commit: `bf2bb83575f7007a9537c5802e5146587990fcc0`.
- Base: `9ed943f7e352c4c56653ed5e003607a3d79d2a34`.
- Exports:
  - `const CONSENT_VERSION = 1`
  - `function consentKey(version: number): string` returns `promptPreflight.consent.v<version>`.
  - `interface ConsentRecord { version: number; decision: "accepted" | "declined"; decidedAt: string }`
  - `function parseConsent(stored: unknown): ConsentRecord | null`
  - `type IncludeCode = "off" | "active-file" | "workspace"`
  - `type IncludeKind = "selection" | "active-file" | "open-editor" | "workspace" | "diagnostic" | "session"`
  - `interface IncludePolicy { includeCode: IncludeCode; activePath?: string }`
  - `function shouldInclude(path: string, kind: IncludeKind, policy: IncludePolicy): boolean`
  - `function isOutsideWorkspace(path: string): boolean` (the shared workspace-boundary predicate; #37 imports it instead of keeping a second copy)
  - `interface RedactionResult { text: string; count: number }`
  - `function redact(text: string): RedactionResult`
  - `function consentedIncludeCode(setting: IncludeCode, consent: ConsentRecord | null): IncludeCode`
  - `const EXCLUDE_GLOB = "**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,.next,target}/**"`
  - `const CLAUDE_DATA_URL = "https://code.claude.com/docs/en/data-usage"`
  - `const CODEX_DATA_URL = "https://openai.com/policies/privacy-policy/"`
  - `function consentMessage(): string`
  - `interface SourcePrivacyFields { chars: number; redactions: number }`
  - Additive core export: `SECRETS` is re-exported from `core/src/index.ts`.
- Setting:
  - Key: `promptPreflight.context.includeCode`.
  - Enum: `off`, `active-file`, `workspace`.
  - Default: `active-file`.
  - Meaning: which code excerpts may be sent. It gates workspace files, diagnostics, and session code excerpts.
  - It does not gate the draft or Q&A. Those are user text and are sent on a model check.
- Consent:
  - Version: `CONSENT_VERSION = 1`.
  - Storage: `context.globalState` under `consentKey(CONSENT_VERSION)`, which is `promptPreflight.consent.v1`.
  - Shape: `{ version: number; decision: "accepted" | "declined"; decidedAt: string }`.
  - `parseConsent` accepts only the current version, an exact decision, and a string `decidedAt`. Older, future, or malformed records return `null`.
  - The notice is a modal `showInformationMessage` with `Accept` and `Decline`. It is shown only when no valid current record exists.
  - A dismissed notice returns `undefined` and is not persisted. It is shown again on the next activation.
  - Accept persists the accepted record. The includeCode preference applies only through `consentedIncludeCode`.
  - Decline persists the declined record and writes `off` in every scope that defines the setting, plus the global baseline. A failed write shows a warning and never includes prompt, file, or secret text.
  - The extension activates regardless of consent. Code inclusion is the gated part.
- Code-inclusion gate:
  - `consentedIncludeCode(setting, consent)` returns `setting` only when `consent?.decision === "accepted"`. Otherwise it returns `off`.
  - Consumers #36 and #38 must pass this effective value into `IncludePolicy.includeCode`, never the raw setting.
  - A dismissed notice therefore leaves code off even though the setting still reads `active-file`.
- Inclusion predicate:
  - `path` is a workspace-relative POSIX path, or `""` for an untitled or virtual document.
  - `shouldInclude` normalizes backslashes to `/` and strips one leading `./`.
  - It rejects a leading `/`, a Windows drive path `^[A-Za-z]:/`, and any path with a `..` segment as outside the workspace.
  - `off` returns false for every kind, including `selection`.
  - `selection` is explicit user text. It is included when it is not excluded and not outside the workspace. An empty path is allowed for a selection from an untitled or virtual document. The caller still runs `redact` on it.
  - `active-file` includes `workspace`, `open-editor`, `diagnostic`, and `session` only when the non-empty path equals `activePath`.
  - `workspace` includes every non-excluded, non-empty, workspace-relative path for `active-file`, `open-editor`, `workspace`, `diagnostic`, and `session`.
  - Empty paths are excluded for every non-selection kind. An unknown kind returns false.
  - Excluded directory segments, case-insensitive: `node_modules`, `.git`, `dist`, `out`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `target`.
  - Excluded basenames, case-insensitive: `.env`, any name starting with `.env.`, `credentials.json`, `id_rsa`, `id_ed25519`, any name ending in `.pem` or `.key`.
  - The exclusion list wins over an explicit selection.
- Redaction:
  - `redact(text)` imports `SECRETS` from core. It does not define a second secret list.
  - Each global regex is cloned before use, so shared `lastIndex` cannot skip a match.
  - Patterns run sequentially over the updated text.
  - Each match is replaced with a per-call, per-match marker `[ [preflight-redacted-<uuid>-<n>] ]`. The marker has a space after the first bracket, so the password-assignment pattern cannot re-match it.
  - Only markers inserted during the call are replaced with `[redacted]`. Pre-existing marker-like strings and NUL characters are preserved.
  - `count` is the number of secret matches replaced. The function never logs the match or the original text.
  - Known gaps: a secret split across lines is not matched. The private-key pattern covers the `BEGIN ... PRIVATE KEY` header only, not the body. Both gaps are recorded for #23.
- Manifest fields:
  - `chars`: final included excerpt size in characters after redaction and truncation. #36 owns the full manifest entry.
  - `redactions`: number of secret matches replaced by `redact` for that source.
- Provider data handling:
  - Claude Code: `https://code.claude.com/docs/en/data-usage`.
  - Codex (OpenAI privacy policy): `https://openai.com/policies/privacy-policy/`.
  - Codex is not implemented yet. #10 owns the adapter.
- Privacy:
  - The notice and `extension/README.md` disclose that drafts, Q&A, reviews, session slices inside review records, and send records are stored unencrypted under `context.globalStorageUri`.
  - Those records leave the machine only inside a model request.
  - `promptPreflight.clearHistory` deletes them. The command lands in #35.
  - The study log is opt-in, separate, and is not deleted by `clearHistory`.
  - There is no telemetry by default.
- Tests:
  - `extension/test/privacy.test.ts`: `npx vitest run extension/test/privacy.test.ts` -> 40 passed.
  - Full suite: `npm test` -> 151 passed.
- Test seams:
  - `shouldInclude`: `extension/test/privacy.test.ts`.
  - `redact`: `extension/test/privacy.test.ts`.
  - `consentKey` and `parseConsent`: `extension/test/privacy.test.ts`.
  - `consentedIncludeCode`: `extension/test/privacy.test.ts`.
  - `consentMessage` content: `extension/test/privacy.test.ts`.
  - `EXCLUDE_GLOB` content: `extension/test/privacy.test.ts`.
  - No VS Code mock. All `vscode` calls stay in `extension.ts`.
- Edge modes covered:
  - `.env`, `.env.local`, `credentials.json`, `id_rsa`, `id_ed25519`, `.pem`, `.key`, `node_modules`, `.git`, and build directories are excluded under active-file and workspace, including selections.
  - Selection in an excluded file is false. Exclusion wins.
  - Untitled or virtual selection is true. Untitled active-file, workspace, open-editor, diagnostic, and session are false.
  - Absolute POSIX and Windows drive paths, and `..` traversal, are false.
  - `off` is false for every kind. Draft and Q&A are not passed to `shouldInclude`.
  - Consent accepted, declined, dismissed, older, future, and malformed are covered.
  - Redaction covers one secret, multiple secrets, repeated calls with shared regex state, a password assignment containing an sk- token, a placeholder-looking secret, unicode, no secret, a split secret, a private-key header, a genuine NUL, and a pre-existing marker-like collision.
- Assumptions:
  - Consumers #36 and #38 must use `consentedIncludeCode` before building an `IncludePolicy`.
  - `EXCLUDE_GLOB` is for `vscode.workspace.findFiles`. Passing a custom exclude replaces the default `files.exclude` behaviour, so #36 must still apply `shouldInclude` to every returned path.
  - The duplicate `EXCLUDE_GLOB` string in `extension/src/workspace.ts` is a known #36 cleanup. #36 moves helpers and must not add a third copy.
  - `promptPreflight.clearHistory` is documented now but is implemented by #35.
  - A declined user has no in-product re-accept path for the same consent version. That is the published behavior.
  - `decidedAt` is checked as a string, not for ISO validity.
  - The build-directory exclusions are part of the predicate so the README claim holds for selections, not only for `findFiles`.
- Consumers:
  - #36: use `shouldInclude`, `redact`, `EXCLUDE_GLOB`, `SourcePrivacyFields`, and `consentedIncludeCode`. The manifest entry must carry `chars` and `redactions`.
  - #38: apply `consentedIncludeCode`, `shouldInclude`, and `redact` to session code excerpts and the derived slice.
  - #13: the deep prompt receives only sources that passed this policy.
  - #46: the manifest exposes the source and size decisions from this policy.
  - #23: owns the split-secret and private-key-body gaps.
- Open gaps:
  - Split-line secrets and private-key bodies are not redacted. #23 owns the fix.
  - `clearHistory` is documented but implemented by #35 (merged).
- Change log:
  - v1: initial contract merged in #41.
  - v1.1: exported `isOutsideWorkspace` for #37 (additive); `workspace.ts` now reuses `EXCLUDE_GLOB` from this contract (#36 cleanup).

<a id="contract-35"></a>

## Contract: #35 JSONL repository and session persistence - v1

- State: merged.
- Commit: `621906d336f7aaaf7d68165a11a01a1d15d52a4e`.
- Base: `6b1384bc0453247d9d2212a16b9bcc7f77a9077c`.
- Exports:
  - `const SCHEMA_VERSION = 1`
  - `type EventInput<T> = { id: string; ts: string } & T`
  - `type Event<T> = { schemaVersion: number; seq: number; id: string; ts: string } & T`
  - `interface ListResult<T> { events: Event<T>[]; skipped: number }`
  - `interface Repository<T> { append(event: EventInput<T>): Promise<Event<T>>; list(): Promise<ListResult<T>>; byDraft(draftId: string): Promise<Event<T>[]>; bySession(sessionId: string): Promise<Event<T>[]> }`
  - `interface SendRecord { draftId: string; folderUri: string; text: string; promptHash: string; sessionId?: string; target: "terminal" | "clipboard" }`
  - `type IdGenerator = () => string`
  - `interface Clock { now(): number }`
  - `type MigrationStep = (event: Event<unknown>) => Event<unknown> | null`
  - `interface MigrationResult<T> { events: Event<T>[]; skipped: number }`
  - `function migrate<T>(events: Event<T>[], steps?: Record<number, MigrationStep>): MigrationResult<T>`
  - `interface ClearResult { deleted: number }`
  - `function isValidEvent(value: unknown): value is Event<unknown>`
  - `class JsonlRepository<T> implements Repository<T>` with `constructor(filePath: string)`, `append`, `list`, `byDraft`, `bySession`, and `clear(): Promise<ClearResult>`.
  - `core/src/index.ts` re-exports `* from "./repository"`.
- Envelope fields:
  - `schemaVersion`: `number`, written as `1` on every append.
  - `seq`: `number`, integer, at least 1, scoped to one file, monotonic, assigned by the repository.
  - `id`: `string`, supplied by the caller. It is the aggregate id, not a uniqueness constraint.
  - `ts`: `string`, supplied by the caller in ISO 8601. The repository does not validate the ISO format or call a clock.
  - Payload keys are top-level. There is no `data` wrapper.
- `SendRecord` fields:
  - `draftId`: `string`, the draft the send belongs to.
  - `folderUri`: `string`, the workspace folder URI for the send.
  - `text`: `string`, the exact sent prompt. This is the only stored prompt copy.
  - `promptHash`: `string`, supplied by #40's `hashPrompt` at send time. The repository never computes it.
  - `sessionId`: `string | undefined`, the resolved agent session id, added by a later version of the same `sendId`.
  - `target`: `"terminal" | "clipboard"`.
  - The envelope `id` is `sendId`; the envelope `ts` is `sentAt`.
- File names and aggregate ids:
  - `drafts.jsonl`: envelope `id` is `draftId`. Payload `text: string`.
  - `questions.jsonl`: envelope `id` is `questionId`. Payload `draftId`, `sessionId?`, and the #15 `Question` fields. #35 does not define those fields.
  - `reviews.jsonl`: envelope `id` is `reviewId`. Payload `draftId`, `sessionId?`, the `DeepReview` from #40/#46, and the derived `SessionSlice` when one exists. #35 does not define or import those types and does not add `slices.jsonl`.
  - `sends.jsonl`: envelope `id` is `sendId`. Payload is `SendRecord`.
- Index mapping:
  - `byDraft` matches the envelope `id` for `drafts.jsonl`.
  - `byDraft` matches the payload `draftId` for `questions.jsonl`, `reviews.jsonl`, and `sends.jsonl`.
  - `bySession` matches the payload `sessionId` for every file. A missing or non-string `sessionId` is not indexed.
  - Unknown ids return `[]`.
- Ordering and versions:
  - `list`, `byDraft`, and `bySession` return events ordered by `seq` ascending.
  - Equal `seq` values keep file order, because the sort is stable.
  - Reads return copies of the arrays; callers cannot mutate the indexes.
  - A later append with the same `id` is a new version ordered by `seq`. Every version is preserved. Consumers fold to the highest `seq` for the current state.
  - `seq` starts at 1 and is `max numeric seq + 1`. A numeric `seq` from a corrupt, invalid, or future-version line still raises the max, so an interrupted write cannot cause a duplicate seq.
- Append behavior:
  - Appends use `fs.appendFile`, UTF-8, one JSON object per line, `\n` terminated. The file is never rewritten.
  - Appends are serialized by a per-file promise queue.
  - `append` creates the parent directory when needed.
  - If the file does not end with `\n`, the append writes a leading `\n` before the new record. The partial line is never truncated or rewritten.
  - After the write resolves, the repository adopts the terminated partial if it is a valid current-or-older event, or counts it as skipped otherwise, and commits the new event to the cache and indexes.
  - A rejected write leaves the repository state unchanged, including the pending partial, so a retry writes the leading `\n` again.
  - `append` resolves only after the bytes reach the file, and returns the stored event including `schemaVersion` and `seq`.
- Read behavior:
  - A missing file returns `{ events: [], skipped: 0 }`.
  - A trailing line without `\n` is ignored and is not counted as skipped.
  - A complete line that fails JSON parsing or envelope validation is skipped and counted.
  - A blank line in the middle is a corrupt line and counts as skipped. The final empty segment after a trailing newline is not a line.
  - An unknown future `schemaVersion` is skipped and counted. An older `schemaVersion` is kept in `list` for the caller to migrate; the repository does not migrate it.
  - Envelope validation requires a plain object, an integer `schemaVersion` of at least 0, an integer `seq` of at least 1, a string `id`, and a string `ts`. Payload fields are not validated except the index keys.
  - A failed read clears the cached load promise, so a later operation retries the read.
- Migration:
  - `migrate(events, steps = {})` is pure and idempotent. It does not mutate its inputs or write files.
  - Events at `SCHEMA_VERSION` pass through.
  - Events above `SCHEMA_VERSION` are skipped and counted.
  - An older event uses `steps[schemaVersion]`. A missing step, a `null` result, a non-event result, or a step that does not increase the version causes the event to be skipped and counted.
  - Multi-hop migrations apply each registered step in order until the event reaches `SCHEMA_VERSION`.
  - A second run on the output is a no-op.
- Clear:
  - `JsonlRepository.clear()` deletes that repository's file, clears the cache, indexes, max seq, and skipped count, and returns `{ deleted }`.
  - `deleted` counts valid events only, not skipped or corrupt lines.
  - A missing file returns `{ deleted: 0 }`.
  - Clear sets a clearing flag synchronously. Appends that begin after clear starts reject with `Error("repository is clearing")`.
  - Clear waits for already queued appends before deleting.
  - After clear, a new append starts at seq 1.
- Clear history command:
  - Command id: `promptPreflight.clearHistory`.
  - Declared in `extension/package.json` with title "Clear History" and category "Prompt Preflight".
  - The command shows a modal warning and proceeds only on the exact "Delete" label.
  - It clears `drafts.jsonl`, `questions.jsonl`, `reviews.jsonl`, and `sends.jsonl`, sums the valid event counts, and reports the total as an event count.
  - It keeps settings and the study log. It does not delete `study-log.jsonl`.
  - If a clear fails, it shows an error message without a raw stack trace.
- Persistence:
  - Files live under `context.globalStorageUri.fsPath`.
  - One file per aggregate. No snapshot, compaction, SQLite, ORM, or `slices.jsonl`.
  - The raw transcript is never stored. The `SessionSlice`, when present, is a derived payload field in a review event.
- Privacy:
  - The exact sent text lives only in `SendRecord.text`. #41 discloses it.
  - The repository never logs prompt text, file contents, paths, or secrets.
- Tests:
  - `extension/test/repository.test.ts`: `npx vitest run extension/test/repository.test.ts` -> 36 passed.
  - Full suite: `npm test` -> 187 passed.
- Test seams:
  - `JsonlRepository<T>(filePath)` public methods: `extension/test/repository.test.ts`.
  - `migrate(events, steps?)`: `extension/test/repository.test.ts`.
  - `clear()`: `extension/test/repository.test.ts`.
  - Temp directories via `node:os.tmpdir()` and `node:fs/promises`.
  - Size test: append grows the file by exactly the new line's bytes and preserves the prefix.
- Edge modes covered:
  - Missing directory, missing file, empty file, corrupt first/middle/last complete line, blank line.
  - Trailing partial with no newline: ignored, not counted. A partial that parses as a valid event is adopted on the next append. A corrupt partial is terminated, counted as skipped, and does not block the append.
  - A partial with a numeric seq raises the next seq even when the envelope is invalid or the schema version is future.
  - Two concurrent appends and a read behind them. Read results sorted by seq with stable ties.
  - Duplicate seq after a crash: the next append uses max numeric seq + 1 and both duplicate-seq events are preserved.
  - Duplicate `id`: both versions preserved and ordered.
  - Unknown future schema version: skipped and counted, but its seq still raises the next append.
  - Unicode and newlines inside string values: one line, round-trip exact.
  - Read-only directory and read-only file: reject with the fs error, then retry after permissions are restored.
  - Failed append over a partial tail: the write rejection leaves the partial pending; the retry preserves both records.
  - Clear while an append is queued: clear waits, counts the queued event, then deletes. A new append after clear begins rejects.
  - Unknown draft/session id: `[]`.
  - `sends.jsonl` with a missing `promptHash` or `sessionId`: the envelope is valid, `list` returns it, `bySession` does not index a missing session.
- Assumptions:
  - The repository does not validate that `ts` is ISO 8601, only that it is a string. The caller owns the format.
  - Older schema versions are returned by `list` and are not migrated automatically. The caller may use `migrate`.
  - A numeric `seq` on any parseable line raises the max, even if the line is skipped. This is the crash-recovery rule.
  - `isValidEvent` is a shared exported helper. It is not a new aggregate schema.
  - `IdGenerator` and `Clock` are published types for the composition root. The repository does not use them; the caller supplies `id` and `ts` directly.
  - `promptHash` is always caller-supplied. #35 does not import or duplicate `hashPrompt`.
  - The repository is not wired to the panel in this ticket. Reload persistence is proven by constructing new repository instances over the same files.
  - The clear command does not clear in-memory panel state or consent. It deletes the four repository files and keeps settings and the study log.
- Consumers:
  - #38: use `SendRecord`, `bySession`, `byDraft`, and the envelope `id`/`ts` mapping. The latest `sendId` version carries the resolved `sessionId`.
  - #43: build the panel protocol on the same repository methods and the clear command.
  - #45: use `migrate` and append migrated study-log events as new events. Do not import `study-log.jsonl` here.
  - #46: store the final `DeepReview` with `contextManifest` as payload fields in `reviews.jsonl`. Do not add `slices.jsonl`.
  - #15: store `Question` payload fields in `questions.jsonl`. #35 does not define them.
- Open gaps:
  - The panel is not wired to append or read repository events yet. #43/#15/#46 own that integration.
  - The clear command does not reset in-memory panel state; the panel state is not persisted in this ticket.
  - `JsonlRepository` is per-instance. Two instances over the same file do not share a cache; the intended composition root uses one instance per file.
- Change log:
  - v1: initial contract merged in #35.

<a id="contract-39"></a>

## Contract: #39 Model provider profiles - v1.1

> **Superseded in v2:** the fields and seams in "Contract deltas in detail" win.
> The text below is retained as the v1 record.


- State: merged.
- Commit: `986b610b2f5bf0ee0b18a3a803c51771fee789ff`.
- Base: `ed0c1d7cb40aee3fe68e633d75b2896839ae124b`.
- Exports:
  - `type ProviderId = "claude" | "codex"`
  - `type ThinkingEffort = "low" | "medium" | "high"`
  - `interface ModelProfile { provider: ProviderId; model: string; thinkingEffort: ThinkingEffort }`
  - `interface Config { provider: ProviderId; model: string; thinkingEffort: ThinkingEffort; quickModel: string; deepModel: string; claudePath: string }`
  - `interface ModelCapabilities { structuredOutput: boolean; thinkingEffort: boolean; maxContextTokens: number; cost: { inputPerMTok: number; outputPerMTok: number }; supportsInstructionFiles: boolean }`
  - `type ProfileValidation = { ok: true } | { ok: false; message: string }`
  - `interface ModelProvider { readonly capabilities: ModelCapabilities; validateProfile(profile: ModelProfile): ProfileValidation; complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> }`
  - `function resolveProfile(settings: Config, mode: ReviewMode): ModelProfile`
  - `function createProvider(profile: ModelProfile, config: Config): ModelProvider`
  - `function createClaudeProvider(profile: ModelProfile, config: { claudePath: string }): ModelProvider`
  - `function buildClaudeArgs(request: ModelRequest, profile: ModelProfile): string[]`
  - `claudeCliRunner(claudePath = "claude", cwd?: string, thinkingEffort: ThinkingEffort = "medium"): ModelRunner` (v1.1 additive third parameter; the v1 two-argument form is still compatible).
  - `parseCliOutput(stdout: string): ModelResponse` remains exported and unchanged.
  - `createCodexStubProvider` and `validateClaudeProfile` are module-private, not package exports.
- `ThinkingEffort` alignment:
  - `ThinkingEffort` is exactly `"low" | "medium" | "high"`.
  - `ModelProfile.thinkingEffort` assigns directly into #40's `ScoreReport.thinkingEffort`.
  - `ModelProfile.provider` assigns into #40's `ScoreReport.provider: string`.
- Settings:
  - `promptPreflight.provider`: string enum `claude`, `codex`; default `claude`. Codex is not implemented yet.
  - `promptPreflight.model`: string; default `sonnet`. It is the fallback when the mode override is empty.
  - `promptPreflight.thinkingEffort`: string enum `low`, `medium`, `high`; default `medium`.
  - `promptPreflight.quickModel`: string; default `haiku`. Empty falls back to `promptPreflight.model`, then `haiku`.
  - `promptPreflight.deepModel`: string; default `sonnet`. Empty falls back to `promptPreflight.model`, then `sonnet`.
  - `promptPreflight.claudePath`: unchanged. There is no second CLI-path setting.
- Profile resolution:
  - `provider`: `settings.provider`.
  - `model`: the mode override (`quickModel` for quick, `deepModel` for deep) when non-empty after trim, then `settings.model` when non-empty after trim, then `haiku` for quick or `sonnet` for deep.
  - `thinkingEffort`: `settings.thinkingEffort`.
  - `resolveProfile` is pure and reads no VS Code API.
- Provider factory:
  - `createProvider` is a pure factory. It returns the Claude adapter for a claude profile, the Codex stub for a codex profile, and throws for an unknown provider at runtime.
  - The factory does not validate the profile implicitly. The caller calls `validateProfile`.
  - The provider instance is bound to the profile. `complete(request, signal?)` takes no profile argument.
- Claude adapter:
  - `buildClaudeArgs` returns exactly `["-p", "--model", profile.model, "--effort", profile.thinkingEffort, "--output-format", "json", "--tools", "", "--setting-sources", "", "--system-prompt", request.system]`.
  - The user prompt is written to stdin, never placed in the args.
  - There is no shell interpolation and no `--json-schema` argument.
  - `complete` rejects if `request.model !== profile.model`, before spawning.
  - `complete` rejects with `Object.assign(new Error("cancelled"), { code: "cancelled" })` if the signal is already aborted, and does not spawn.
  - An abort during the spawn maps to the same cancelled error.
  - The default timeout is 120000 ms. A caller `AbortSignal` can shorten it. There is no retry.
  - A nonzero exit rejects with an `Error` whose message is stderr or the process error. The error carries `code` from the process error when present.
  - A missing CLI rejects with `Claude Code CLI not found at "<path>". Install it or set promptPreflight.claudePath.` and `code: "ENOENT"`.
  - Success resolves `parseCliOutput(stdout)`.
- Capability matrix:
  - Claude: `structuredOutput: true`, `thinkingEffort: true`, `maxContextTokens: 200000`, `supportsInstructionFiles: true`.
  - Claude cost, USD per million tokens, by model substring:
    - contains `haiku`: `{ inputPerMTok: 0.1, outputPerMTok: 0.5 }`.
    - contains `sonnet`: `{ inputPerMTok: 2, outputPerMTok: 10 }`.
    - contains `opus`: `{ inputPerMTok: 4, outputPerMTok: 20 }`.
    - unknown model: `{ inputPerMTok: 0, outputPerMTok: 0 }`. The gap is recorded.
  - Price source, accessed 2026-11-16: `https://platform.claude.com/docs/en/about-claude/pricing`.
    - The haiku row is the Claude Haiku 5.5 base tier for prompts up to 100,000 tokens. The over-100k tier is not encoded in the single cost pair.
    - The sonnet row is Claude Sonnet 5.5.
    - The opus row is Claude Opus 5.5.
  - `maxContextTokens` is pinned to 200000 by lane brief 8.4. Current published windows are larger. #42 should revisit if the real window matters.
  - `structuredOutput: true` is recorded because the CLI exposes `--json-schema`, but no schema argument is built because #40 exports no JSON Schema. This is a follow-up, not a current feature.
  - `supportsInstructionFiles: true` because `--setting-sources ""` disables instruction auto-load, so #46 decides what to load through #48.
  - Codex stub: `structuredOutput: false`, `thinkingEffort: false`, `maxContextTokens: 0` (unknown), cost zeros, `supportsInstructionFiles: false` until #10 proves auto-load can be disabled.
- Validation:
  - `validateProfile(profile)` never throws.
  - Claude rejects a non-claude provider, an empty or whitespace-only model, and an effort outside the enum. It accepts all three efforts.
  - The Codex stub rejects every profile with `Codex provider is not implemented; use Claude.`.
  - The Codex stub `complete` rejects with the same message.
- Legacy panel path:
  - `claudeCliRunner` keeps its `ModelRunner` type and its two-argument compatibility.
  - It binds a profile `{ provider: "claude", model: req.model, thinkingEffort }` and passes `--effort <thinkingEffort>`.
  - The default effort stays `medium`. The optional third parameter lets the panel pass the resolved profile effort.
  - The panel now calls `claudeCliRunner(config.claudePath, workspaceRoot, profile.thinkingEffort)` and passes `profile.model` to `review()`. This preserves the workspace cwd for the Claude session and makes the model/effort settings effective.
  - The new provider `complete()` path is still not used by the panel. The provider is used for validation and health checks. #46 may use `complete()` for deep feedback.
- Extension wiring:
  - `readModelConfig()` in `extension/src/modelSettings.ts` reads the six settings into a plain `Config` object. It is shared by `extension.ts` and `panel.ts`.
  - #42 replaced the v1 `validateModelSettings` helper with `checkHealth` (profile validation plus CLI presence). The activation health check is non-blocking and non-modal.
  - `probeEffortSupport(config)` remains. It runs only for `provider === "claude"`, with a read-only `claude --help`, a 2-second timeout, and a 1 MB buffer. It checks stdout and stderr for `--effort`. A failed probe is silent; the activation health check owns missing-CLI errors. A successful probe without the flag shows a non-modal warning.
  - The probe never runs a model call and never logs prompt or file text.
- Tests:
  - `core/test/model.test.ts`: `npx vitest run core/test/model.test.ts` -> 21 passed.
  - `core/test/claudeCli.test.ts`: `npx vitest run core/test/claudeCli.test.ts` -> 19 passed.
  - Full suite: `npm test` -> 227 passed.
- Test seams:
  - `resolveProfile`: `core/test/model.test.ts`.
  - `provider.validateProfile`: `core/test/model.test.ts`.
  - `createProvider`: `core/test/model.test.ts`.
  - `buildClaudeArgs`: `core/test/claudeCli.test.ts`.
  - `parseCliOutput`: `core/test/claudeCli.test.ts` and the existing `core/test/review.test.ts`.
  - Fake CLI harness for spawn, abort, stderr, nonzero exit, invalid JSON, empty output, and missing usage/cost: `core/test/claudeCli.test.ts`. No real CLI and no network.
- Edge modes covered:
  - Quick override set, deep override unset, both empty, whitespace-only overrides, empty global model, provider/effort passthrough.
  - User and workspace settings as separate plain `Config` objects.
  - Claude valid profile, foreign provider, empty model, invalid effort, default effort.
  - Codex validate rejection and complete rejection.
  - Capabilities for haiku, sonnet, opus, unknown model, and Codex.
  - `buildClaudeArgs` for low, medium, high; exact array; no prompt in args; no `--json-schema`.
  - Fake CLI success with stdin round-trip; stderr warning with exit 0; nonzero exit with code; invalid JSON; empty output; missing usage/cost.
  - Abort before spawn with no spawn; abort during spawn with cancelled error; model mismatch with no spawn.
  - Missing CLI ENOENT hint with code.
  - Legacy runner passes `--effort medium`.
- Assumptions:
  - #40's `ScoreReport` field names matched; no schema change.
  - Model aliases and names are matched by substring for the price table. A future model name with a different price falls back to zero and must be added deliberately.
  - The haiku cost is the base tier. The over-100k tier is not represented.
  - `maxContextTokens` 200000 is a lane pin, not the current published maximum.
  - `structuredOutput` is a capability flag only; no JSON Schema argument exists yet.
  - The new provider `complete()` path is not wired to the panel. The panel uses the legacy `claudeCliRunner` with the resolved model/effort and the workspace cwd. The provider is used for validation and health checks.
  - Codex is a stub. Selecting it warns and rejects; #10 owns the real adapter.
- Consumers:
  - #42: used `ModelProvider.validateProfile` through `checkHealth`, the cancelled error code, and the capabilities. It did not use `complete()`; the panel still uses the legacy runner with cwd. Do not assume `probeEffortSupport` is a health check.
  - #26: use `resolveProfile` and `parseQuickReview` with the profile fields.
  - #46: use `supportsInstructionFiles` to decide whether to call #48's loader.
  - #10: replace the Codex stub with the real adapter; keep the `ProviderId` and capability shape.
  - #12: use the profile/provider contract for direct extension input.
  - #45: use `capabilities.cost` for study-log cost reporting.
  - #38: use `ModelProfile` for the session slice token cap.
  - #6: use `resolveProfile` for quick model selection.
  - #22: use `validateProfile` and the cancelled/error codes for missing CLI and auth handling.
  - #27: use the profile fields in `ScoreReport`.
- Open gaps:
  - The panel is not wired to the new provider `complete()` path. It uses `claudeCliRunner` with the resolved model/effort and the workspace cwd. The `provider` and `thinkingEffort` settings do change the panel call; the Codex provider is rejected by the health check.
  - `structuredOutput` has no JSON Schema argument.
  - The cost table is a substring table with a zero fallback for unknown models.
  - The Codex stub is not a working provider.
- Change log:
  - v1: initial contract merged in #39.
  - v1.1: #42 added the optional third `thinkingEffort` parameter to `claudeCliRunner` and wired the panel to the resolved model/effort while preserving the workspace cwd. Additive; no consumer break. The #42 ledger records the change.

<a id="contract-42"></a>

## Contract: #42 Feedback errors and degraded modes - v1

- State: merged.
- Commit: `507ee22d48d26de29a5cf3e88982040105b40e65`.
- Base: `35c6a3b`.
- Exports:
  - `type FeedbackErrorCode = "provider-missing" | "auth-missing" | "quota" | "timeout" | "invalid-response" | "context-too-large" | "cancelled" | "unknown"`
  - `type FeedbackAction = "open-settings" | "install-cli" | "fix-permissions" | "retry" | "reduce-context" | "dismiss"`
  - `interface FeedbackError { code: FeedbackErrorCode; message: string; action: FeedbackAction; retryable: boolean; cause?: string }`
  - `function isFeedbackError(value: unknown): value is FeedbackError`
  - `function mapError(err: unknown): FeedbackError`
  - `function isRetryable(error: FeedbackError): boolean`
  - `function feedbackMessage(error: FeedbackError): { message: string; action: FeedbackAction }`
  - `function feedbackLogMessage(error: FeedbackError, correlationId: string): string`
  - `const ACTION_LABELS: Record<FeedbackAction, string>`
  - `function exceedsContext(totalTokens: number, maxContextTokens: number): boolean`
  - `function exceedsBudget(totalTokens: number, budget: number): boolean`
  - `type HealthResult = { ok: true } | { ok: false; error: FeedbackError }`
  - `type HealthExecutor = (command: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => void`
  - `function checkHealth(provider: ModelProvider, profile: ModelProfile, cliPath: string, exec?: HealthExecutor): Promise<HealthResult>`
  - `core/src/index.ts` re-exports `./errors`.
  - `extension/src/modelSettings.ts`: `function readModelConfig(): Config`.
  - `extension/src/panel.ts`: `function showFeedbackError(error: FeedbackError, retry?: () => void): void`.
  - #39 addendum: `claudeCliRunner(claudePath = "claude", cwd?: string, thinkingEffort: ThinkingEffort = "medium"): ModelRunner`.
- Fixed messages:
  - `provider-missing`: "The selected model provider is not available. Install its CLI or choose another provider in settings."
  - `auth-missing`: "The model provider rejected the login. Sign in again or check your credentials."
  - `quota`: "The model provider quota is exhausted. Check your plan or try again later."
  - `timeout`: "The model provider did not answer in time."
  - `invalid-response`: "The model provider returned an unreadable answer."
  - `context-too-large`: "The context is too large for the selected model. Reduce the included code and try again."
  - `cancelled`: "The request was cancelled."
  - `unknown`: "Something went wrong while asking the model provider."
- Actions:
  - `provider-missing`: `install-cli` for ENOENT, `fix-permissions` for EACCES/EPERM, `open-settings` for an invalid profile or unknown provider.
  - `auth-missing`: `open-settings`.
  - `quota`: `open-settings`.
  - `timeout`: `retry`.
  - `invalid-response`: `retry` (manual retry only).
  - `context-too-large`: `reduce-context`.
  - `cancelled`: `dismiss`.
  - `unknown`: `dismiss`.
- Action labels:
  - `open-settings`: "Open Settings".
  - `install-cli`: "Install CLI".
  - `fix-permissions`: "Fix Permissions".
  - `retry`: "Retry".
  - `reduce-context`: "Reduce Context".
  - `dismiss`: "Dismiss".
- `mapError` order:
  1. A full `FeedbackError` is returned unchanged by reference.
  2. `code: "cancelled"`, `name: "AbortError"`, or `code: "ABORT_ERR"` -> `cancelled`.
  3. `ENOENT` -> `provider-missing`/`install-cli`.
  4. `EACCES` or `EPERM` -> `provider-missing`/`fix-permissions`, never auth.
  5. Status/code 429, quota, rate limit, or too many requests -> `quota`.
  6. Status/code 401 or 403, or an auth message -> `auth-missing`. Auth is checked before timeout.
  7. `killed`, `SIGTERM`, `ETIMEDOUT`, or a timeout message -> `timeout`.
  8. `SyntaxError`, JSON parse, parse, unexpected, or empty output/result -> `invalid-response`.
  9. Context window, maximum context, too many tokens, or token limit -> `context-too-large`.
  10. Unknown model provider or a "not implemented; use Claude" message -> `provider-missing`/`open-settings`.
  11. Anything else, including a generic nonzero exit -> `unknown`.
  - Mapped raw errors never set `cause`. A raw stderr message is not copied to `message` or `cause`.
  - A validation failure in `checkHealth` may carry the safe `validation.message` as `cause`.
- Retry policy:
  - `isRetryable(error)` is true only when `error.code === "timeout"`.
  - The panel retries a retryable error at most once automatically. A manual "Retry" action can start a new attempt.
  - Auth, quota, provider-missing, invalid-response, context-too-large, cancelled, and unknown are not retryable.
- Health check:
  - `checkHealth` calls `provider.validateProfile(profile)` first. On `{ ok: false }`, it returns `provider-missing` with `open-settings`, the safe validation message as `cause`, and does not run the executor.
  - On a valid profile, it runs `exec(cliPath, ["--version"], { timeout: 2000 }, cb)`. The default executor uses `execFile` with `maxBuffer: 64 * 1024`.
  - A successful executor result returns `{ ok: true }`.
  - An executor error returns `{ ok: false, error: mapError(error) }`.
  - A synchronous throw from validation or the executor returns a mapped error.
  - The health check runs no model call. It does not prove auth; a first-call auth failure maps to `auth-missing`.
  - Activation: the quick profile is checked non-blocking and non-modal. `showFeedbackError` surfaces the fixed message and action. A read-only `claude --help` probe still checks `--effort` for Claude profiles only.
  - Before a review: the panel awaits `checkHealth` for the mode's profile. A failure posts the fixed error and returns before the model call.
- Context and budget pre-checks:
  - `exceedsContext(totalTokens, maxContextTokens)` returns `maxContextTokens > 0 && totalTokens > maxContextTokens`.
  - Exactly at the model window is allowed. One token over fails. A zero or negative window is unknown and skips the pre-check.
  - `exceedsBudget(totalTokens, budget)` returns `totalTokens > budget`. Exactly at the budget is allowed.
  - The caller passes `provider.capabilities.maxContextTokens` to `exceedsContext`. This is an adaptation from the lane brief's `(totalTokens, profile)` because #39's `ModelProfile` has no `capabilities` field.
  - #36's `ContextManifest.totalTokens > budget` is the tighter check. #36/#46 must call `exceedsBudget` and return `context-too-large` before the provider call, even when the model window is larger.
  - The panel has no bundle/token source in this ticket, so the predicates are published and tested; #36/#46 wire the real bundle count.
- Panel and degraded UI:
  - Before each review, the panel reads `readModelConfig()`, resolves the profile, creates the provider, and awaits `checkHealth`.
  - The actual review call uses `claudeCliRunner(config.claudePath, workspaceRoot, profile.thinkingEffort)` and `review(..., profile.model, ...)`. This preserves the workspace cwd for the Claude session and applies the resolved model and effort.
  - On a review error, the panel maps it. A timeout is retried once automatically. The final error posts `{ type: "review", mode, text, error: fixedMessage }` to the webview and calls `showFeedbackError(error, () => runReview(mode))`.
  - The webview error path clears the loading state. The current rule analysis stays in `this.analysis`; rule findings and the tier-1 rule score remain. The model score is not updated.
  - Quick-only: a deep failure replaces the deep section; the current quick review remains.
  - Rules-only: both model calls fail; rule findings remain; no model score is shown. The tier-1 rule score is separate and remains.
  - No-score: no current `ScoreReport` exists; the panel shows rule findings and no model score.
  - A quick review aborted by an edit that no longer qualifies posts the fixed `cancelled` message to clear the spinner. A supersede with a follow-up review lets the follow-up update the state.
  - A true user cancel button is #43. The panel does not add one.
- Logging:
  - `showFeedbackError` logs `console.error(feedbackLogMessage(error, randomUUID()))`.
  - The format is exactly `[prompt-preflight] <correlationId> <code>`.
  - The log never contains the message, cause, prompt, request, stderr, file contents, or paths.
- Tests:
  - `core/test/errors.test.ts`: `npx vitest run core/test/errors.test.ts` -> 67 passed.
  - `core/test/claudeCli.test.ts`: `npx vitest run core/test/claudeCli.test.ts` -> 20 passed.
  - Full suite: `npm test` -> 295 passed.
- Test seams:
  - `mapError`: `core/test/errors.test.ts`.
  - `isRetryable`: `core/test/errors.test.ts`.
  - `feedbackMessage`: `core/test/errors.test.ts`.
  - `feedbackLogMessage`: `core/test/errors.test.ts`.
  - `checkHealth` with a real `createProvider` Claude profile and a fake executor: `core/test/errors.test.ts`.
  - `exceedsContext`: `core/test/errors.test.ts`.
  - `exceedsBudget`: `core/test/errors.test.ts`.
  - `claudeCliRunner` high effort: `core/test/claudeCli.test.ts`.
  - No VS Code mock. The panel/extension glue is not unit-tested.
- Edge modes covered:
  - ENOENT -> provider-missing/install-cli. EACCES/EPERM -> provider-missing/fix-permissions.
  - AbortError or `code: "cancelled"` -> cancelled. Provider timeout -> timeout/retry, retryable true.
  - 429/quota -> quota. 401/403/auth -> auth. Auth before timeout when both appear.
  - Generic exit code 1 with stderr -> unknown, not auth.
  - SyntaxError, empty output, invalid JSON -> invalid-response.
  - Context overflow -> context-too-large. Unknown model provider -> provider-missing.
  - A full FeedbackError passes through by reference.
  - null/undefined/string/number -> unknown.
  - A raw message containing a fake secret does not reach the message or cause.
  - `checkHealth`: valid profile + success -> ok; invalid profile -> provider-missing with no executor call; Codex stub -> provider-missing with the Codex message; ENOENT -> install-cli; EACCES -> fix-permissions; timeout -> retry; synchronous throw -> mapped.
  - `exceedsContext`: at limit false, one over true, zero/negative max false.
  - `exceedsBudget`: at budget false, one over true.
  - Quick-only, rules-only, and no-score states.
  - A quick review aborted by a short edit clears the spinner with the fixed cancelled message.
- Assumptions:
  - `exceedsContext` takes the max token number directly. This is the published #42 shape. #36/#46 pass `provider.capabilities.maxContextTokens`.
  - #36's bundle/manifest does not exist yet. The context/budget integration is a predicate contract for #36/#46, not an end-to-end panel check.
  - The panel uses the legacy `claudeCliRunner` with the resolved model/effort and the workspace cwd. The provider `complete()` path is not used by the panel; #46 may use it.
  - The tier-1 rule score is not the model score. "Show no score" in the degraded modes means no model `ScoreReport`.
  - A true cancel button is #43. The supersede cleanup is not a user cancel.
  - `mapError` uses English wording heuristics for quota/auth/timeout/invalid/context. An unknown wording falls back to `unknown` with `dismiss`, which is the safe default.
- Consumers:
  - #27: use `mapError`, `isRetryable`, `feedbackMessage`, and the degraded states for the score/send gate.
  - #43: build the typed protocol and a real cancel action; reuse the `FeedbackError` union, fixed messages, actions, and health check.
  - #46: use `exceedsContext(totalTokens, provider.capabilities.maxContextTokens)`, `exceedsBudget(manifest.totalTokens, manifest.budget)`, and the health check before deep feedback.
  - #47: use `FeedbackError`/`feedbackMessage` for the deep review rendering.
  - #10: map Codex CLI errors into the same union; the Codex stub is the seam.
  - #12: use the error actions for direct extension input.
  - #22: use `mapError`, `checkHealth`, and the actions for missing CLI/auth handling.
- Open gaps:
  - The real bundle token count and manifest budget do not exist until #36. The pre-check is a published predicate, not wired to the panel.
  - A true user cancel action is #43. The panel only handles supersede cleanup and provider timeouts.
  - The panel's actual review still uses the legacy `claudeCliRunner`, not the provider `complete()` path. The provider is used for validation and health. #46 may switch to `complete()`.
  - The rule score remains visible on failure; only the model score is absent.
- Change log:
  - v1: initial contract merged in #42.

<a id="contract-36"></a>

## Contract: #36 Context assembler and manifest - v1

> **Superseded in v2:** the fields and seams in "Contract deltas in detail" win.
> The text below is retained as the v1 record.


- State: merged.
- Commit: `495b52853631580933232fea1a3941c94adb5510`.
- Base: `0c62960`.
- Exports from `core/src/context.ts` (re-exported from `core/src/index.ts`):
  - `type OmitReason = "budget" | "empty" | "excluded" | "unsupported" | "error"`
  - `type ContextKind = "selection" | "active-file" | "open-editor" | "git-diff" | "test-command" | "diagnostic" | "symbol" | "reference" | "definition" | "workspace-symbol" | "text-search" | "session"`
  - `type ContextSourceId = "draft" | "qa" | "session-slice" | "selection" | "active-editor" | "open-editors" | "git-diff" | "diagnostics" | "symbols" | "references" | "definitions" | "workspace-symbols" | "test-command"`
  - `const SOURCE_PRIORITIES: Record<ContextSourceId, number>` with the reserved table below.
  - `interface ContextProvenance { kind: ContextKind; path?: string; range?: Range; truncated: boolean; reason?: string; chars: number; redactions?: number; folderUri?: string }`
  - `interface ContextFragment { source: string; priority: number; content: string; tokens: number; provenance: ContextProvenance }`
  - `interface ContextSourceResult { fragments: ContextFragment[]; omittedReason?: OmitReason; details?: Record<string, string | number | boolean> }`
  - `interface ContextSource { id: string; priority: number; maxTokens?: number; collect(signal?: AbortSignal): Promise<ContextSourceResult> }`
  - `interface ContextInput { draft: string; qa: Array<{ question: string; answer: string }> }`
  - `interface ContextSourceEntry { source: string; chars: number; tokens: number; included: boolean; truncated: boolean; omittedReason?: OmitReason; redactions: number; details?: Record<string, string | number | boolean> }`
  - `interface ContextManifest { sources: ContextSourceEntry[]; totalTokens: number; budget: number }`
  - `interface ContextBundle { draft: string; qa: Array<{ question: string; answer: string }>; fragments: ContextFragment[]; manifest: ContextManifest }`
  - `interface RedactResult { text: string; count: number }`
  - `interface AssembleOptions { budget: number; estimateTokens: (text: string) => number; redact: (text: string) => RedactResult; extraEntries?: ContextSourceEntry[]; signal?: AbortSignal }`
  - `function estimateTokens(text: string): number` = `Math.ceil(text.length / 4)`.
  - `function assemble(input: ContextInput, sources: ContextSource[], options: AssembleOptions): Promise<ContextBundle>`.
- Exports from `extension/src/exec.ts`:
  - `type ExecResult = { ok: true; stdout: string } | { ok: false; code?: string; stderr: string }`
  - `type ExecFileLike = (command: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }, callback: (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void) => void`
  - `function git(cwd: string, args: string[], exec?: ExecFileLike): Promise<ExecResult>`
- Exports from `extension/src/contextSources.ts`:
  - `interface ContextSourceDeps { folder?: vscode.WorkspaceFolder; policy: IncludePolicy; git?: (cwd: string, args: string[]) => Promise<ExecResult>; readFile?: (uri: vscode.Uri) => Thenable<Uint8Array> }`
  - `createSelectionSource(deps): ContextSource`
  - `createActiveEditorSource(deps): ContextSource`
  - `createOpenEditorsSource(deps): ContextSource`
  - `createGitDiffSource(deps): ContextSource`
  - `createTestCommandSource(deps): ContextSource`
  - `activePathFor(uri: vscode.Uri, folder?: vscode.WorkspaceFolder): string`
  - `resolveContextFolder(draft: string, activeUri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined>`
- Reserved source ids and priorities:
  | Source id | Priority |
  |---|---|
  | `draft` | 100 |
  | `qa` | 90 |
  | `session-slice` | 85 |
  | `selection` | 80 |
  | `active-editor` | 70 |
  | `open-editors` | 60 |
  | `git-diff` | 50 |
  | `diagnostics` | 45 |
  | `symbols` | 40 |
  | `references` | 39 |
  | `definitions` | 38 |
  | `workspace-symbols` | 37 |
  | `test-command` | 30 |
- Manifest entry fields:
  - `source`: the source id, or the extra-entry id such as an instruction file.
  - `chars`: final included characters after redaction and truncation.
  - `tokens`: final included tokens from the injected estimator.
  - `included`: true when at least one workspace fragment remains.
  - `truncated`: true when the source cap or total budget truncated or dropped a fragment.
  - `omittedReason`: set only when `included` is false. One of the `OmitReason` values.
  - `redactions`: number of secret matches replaced for the included fragments, without double counting.
  - `details`: flat source-specific record of string, number, or boolean values.
- Invariants:
  - `draft` and `qa` are first-class bundle fields, not `ContextSource` implementations. A source id `draft` or `qa` throws.
  - Duplicate source ids throw. Duplicate extra-entry ids throw. An extra entry that collides with `draft`, `qa`, or a collected source id throws.
  - Sources are sorted by priority descending, then id ascending. The input array is not mutated.
  - `draft` and `qa` are redacted before estimation and returned redacted. They are never truncated. Their manifest entries come first.
  - Workspace budget is `max(0, budget - draftTokens - qaTokens)`.
  - Sources are collected in sorted order. Every source is collected, even after the workspace budget reaches 0. The caller signal is passed to every `collect`.
  - A source that throws is omitted with `error`; the bundle continues. An abort rejects the whole assemble with no partial bundle.
  - A source that returns no fragments is omitted with its `omittedReason` or `empty`.
  - Redaction runs before token estimation and budgeting. A fragment with `provenance.redactions` defined is treated as already redacted and is not redacted again.
  - The per-source `maxTokens` cap is applied across the source's fragments in order, before the total budget.
  - The source cap and total budget are token caps. A fragment that crosses a cap is truncated at a line boundary; if no line boundary fits, it is cut at `cap * 4` characters and trimmed to fit. The source is marked truncated. Later fragments or sources are dropped.
  - `chars` is the final included size, not the pre-truncation size. `tokens` is `estimateTokens(final content)`.
  - `manifest.totalTokens` = draftTokens + qaTokens + included workspace source tokens. It excludes `extraEntries`. It may exceed `manifest.budget` when the draft/QA floor exceeds the budget; the caller rejects that bundle with `context-too-large`.
  - `manifest.sources` order is draft, qa, workspace sources in priority/id order, then extra entries sorted by source id.
  - `fragments` contains only the final included workspace fragments, in source order. Draft, Q&A, and extra entries are not fragments.
  - Extra entries do not consume the bundle budget and are not in `totalTokens`. #48 truncates its own text; #13 places it in the system prompt.
  - A source order change does not change the output.
  - `estimateTokens("")` is 0, four characters is 1, five characters is 2.
- Errors and omission reasons:
  - `budget`: the source had content but the source cap or total budget left no room.
  - `empty`: no content.
  - `excluded`: #41's exclusion policy rejected the file or the diff section.
  - `unsupported`: no git, not a repo, no folder, or an unsupported collector context.
  - `error`: the source threw.
  - Duplicate/reserved ids are contract errors, not omissions.
  - Abort rejects with `Object.assign(new Error("cancelled"), { code: "cancelled" })`, or `signal.reason` when it is an Error.
- Basic sources:
  - `selection`: active editor selection; no editor or empty selection -> `empty`; path via `activePathFor`; `shouldInclude(path, "selection", policy)`; untitled selection with path `""` is allowed; range = document offsets; kind `selection`; priority 80.
  - `active-editor`: full active document when the selection is empty; a non-empty selection makes it `empty`; untitled/virtual -> `excluded`; `shouldInclude(path, "active-file", policy)`; kind `active-file`; priority 70.
  - `open-editors`: other open text documents; excludes the active document, untitled/virtual, excluded paths, and whitespace-only content; one fragment per document; kind `open-editor`; priority 60; details `{ files: number }`.
  - `git-diff`: `git diff HEAD --no-ext-diff --unified=3`; no folder or git failure -> `unsupported`; empty stdout -> `empty`; split into `diff --git` sections; use the `+++ b/` path or the header path; strip quotes and normalize backslashes; drop sections where `shouldInclude(path, "workspace", policy)` is false; all dropped -> `excluded`; kind `git-diff`; priority 50; details `{ files: included, dropped }`.
  - `test-command`: reads `package.json` `scripts.test`; never executes it; no folder -> `unsupported`; missing file, invalid JSON, or no string/empty script -> `empty`; content is the script string; kind `test-command`; path `package.json`; priority 30; details `{ script: "test" }`.
  - The basic sources set no `maxTokens`; the assembler's total budget controls them.
  - The test command is not gated by `includeCode` because it is a script name, not a code excerpt.
  - Every basic source records `folderUri` in provenance when a folder exists.
  - `resolveContextFolder` checks the draft path references against each workspace folder with `vscode.workspace.fs.stat`, returns the first folder that owns one, else the active editor's folder, else `undefined`.
  - `activePathFor` returns `""` for non-file/untitled URIs, a workspace-relative POSIX path for a file in the folder, and a `..` path for a file outside it; #41 rejects the outside path.
- `exec.ts` and `workspace.ts`:
  - `git` uses `execFile` with `cwd`, a 5000 ms timeout, and a 1 MB buffer. No shell.
  - Success returns `{ ok: true, stdout }`. Failure returns `{ ok: false, code?: string, stderr }`; a non-zero numeric exit code is not included in `code`.
  - `workspace.ts` uses the result union; `gitRecentFiles` handles status and log independently, so one failing command does not discard the other.
  - `workspace.ts` reuses `EXCLUDE_GLOB` from `privacy.ts`; there is no third glob copy.
- Tests:
  - `core/test/context.test.ts`: `npx vitest run core/test/context.test.ts` -> 24 passed.
  - `extension/test/exec.test.ts`: `npx vitest run extension/test/exec.test.ts` -> 3 passed.
  - Full suite: `npm test` -> 322 passed.
- Test seams:
  - `assemble(input, sources, options)`: `core/test/context.test.ts`.
  - `estimateTokens`: `core/test/context.test.ts`.
  - `SOURCE_PRIORITIES`/`ContextSourceId`: `core/test/context.test.ts` and the collector code.
  - `git(cwd, args, fakeExec)`: `extension/test/exec.test.ts`.
  - Fake sources with fixed priorities and ids: `core/test/context.test.ts`.
  - Abort rejects: `core/test/context.test.ts`.
  - No `vscode` mock. The optional collector behavior test was deleted because it used `vi.mock("vscode")`, which the lane rule allows only for a thin adapter test named in a ticket.
- Edge modes covered:
  - No sources, zero budget, empty draft/Q&A, one source larger than the budget.
  - Draft+Q&A exceed the budget: both full, `totalTokens > budget`, workspace sources omitted `budget`.
  - Draft+Q&A exactly at the budget: workspace budget 0, all workspace sources omitted `budget`.
  - Source exactly at its cap/budget and one token over.
  - Source cap across multiple fragments; later fragments dropped.
  - Priority ties, duplicate/reserved ids, extra-entry collisions, source order changes.
  - Every omission reason; a throwing source isolated as `error`; details preserved on omissions.
  - Abort before, during, and after a collect; no partial bundle.
  - Redaction before estimation; already-redacted counts not double-counted.
  - CRLF preservation, line-boundary truncation, mid-line fallback, zero cap, empty fragment.
  - Extra entries after sources, sorted by id, excluded from `totalTokens` and `fragments`.
- Assumptions:
  - `ContextSourceResult.details` is the carrier for #38's `sourcePath`/`bytesRead`/`turnsKept` and #48's file facts. The brief's `collect` return shape omitted it, but the manifest `details` needs a producer.
  - The assembler collects every source even after the budget is spent so the manifest can explain each omission and the abort signal reaches every `collect`.
  - The test-command source is not gated by `includeCode`; it is a script name, not a code excerpt.
  - `ContextSourceDeps.git` is a two-argument subset of `typeof git`; the helper's optional third fake executor is not exposed through the deps.
  - Open editors skips whitespace-only documents, slightly stronger than literal emptiness.
  - Git diff drops a section with no parseable path; a section with unquoted spaces (Git normally quotes them) is not vetted and is dropped. Git C-style escapes are not unescaped; no reachable privacy failure because the exclusion list uses exact names.
  - A fragment whose first line is empty and whose next line exceeds the cap truncates to `""`; the source is recorded as `budget`. This is a narrow edge.
  - The collectors have no behavior test after the vscode-mock test was removed. They are thin and reviewed by reading.
  - The `assemble` ordering/cap/truncation/omit/abort seams were green-first after one large first green. This is a process deviation, disclosed, not a contract change.
- Consumers:
  - #37: implement the reserved diagnostics/symbols/references/definitions/workspace-symbols sources with the reserved ids/priorities, return `ContextSourceResult` fragments with `provenance.kind`, and use `ContextSource.maxTokens` only when a token cap is intended (the #37 count caps are separate).
  - #38: implement `session-slice` at priority 85; use `estimateTokens`, `SOURCE_PRIORITIES`, `ContextFragment`, and the `details` carrier for `sourcePath`, `bytesRead`, `turnsKept`.
  - #46: call `assemble` with the real budget and redactor, map `Question` records into `qa`, surface `manifest` to the deep prompt, and reject `manifest.totalTokens > manifest.budget` as `context-too-large`.
  - #48: supply `extraEntries` with unique source strings and flat `details`; #36 sorts them after the source entries and excludes them from `totalTokens`.
  - #13: place #48's instruction text in the system prompt; the extra entries are manifest-only.
- Open gaps:
  - #37 sources, #38 session source, and #48 extra-entry producer are not implemented here.
  - The panel does not build a bundle yet. #46 owns that integration.
  - The leading-empty-line truncation edge and the Git C-escape limitation are recorded assumptions, not fixed.
  - The collectors have no behavior test after the lane's no-vscode-mock rule; #37's thin `LanguageApi` adapter test is the allowed platform seam.
  - The `manifest.totalTokens > budget` rejection is the caller's job; the assembler returns the bundle.
- Change log:
  - v1: initial contract merged in #36.

<a id="contract-37"></a>

## Contract: #37 Language context provider - v1

> **Superseded in v2:** the fields and seams in "Contract deltas in detail" win.
> The text below is retained as the v1 record.


- State: merged.
- Commit: `96ce4605b489049d8c6919c8bcbd429ff2cc66f3`.
- Base: `99b7392`.
- Exports from `extension/src/languageContext.ts`:
  - `interface LanguagePosition { line: number; character: number }` (0-based; display adds 1).
  - `interface LanguageRange { start: LanguagePosition; end: LanguagePosition }`.
  - `interface LanguageAnchor { uri: string; path?: string; range: LanguageRange }`.
  - `interface LanguageLocation extends LanguageAnchor { name?: string }`.
  - `interface LanguageSymbol { name: string; kind: string; uri?: string; path?: string; range?: LanguageRange; containerName?: string }`.
  - `interface LanguageDiagnostic extends LanguageAnchor { severity: string; source?: string; message: string }`.
  - `interface TextSearchMatch extends LanguageAnchor { preview?: string }`.
  - `interface TextSearchOptions { cwd?: string; maxResults: number }`.
  - `interface LanguageApi { documentSymbols(uri); workspaceSymbols(query); definitions(uri, position); references(uri, position); diagnostics(uri); textSearch(query, options) }`.
  - `interface LanguageCapabilities { documentSymbols: boolean; workspaceSymbols: boolean; definitions: boolean; references: boolean; diagnostics: boolean }`.
  - `const MAX_DIAGNOSTICS = 200`, `MAX_DOCUMENT_SYMBOLS = 100`, `MAX_WORKSPACE_SYMBOLS = 50`, `MAX_DEFINITIONS = 20`, `MAX_REFERENCES = 50`, `MAX_TEXT_SEARCH_MATCHES = 50`.
  - `function withTimeout<T>(promise, ms, signal?): Promise<T>`.
  - `isOutsideWorkspace` is imported from #41's `privacy.ts`; this module no longer defines a second copy.
  - `function buildDiagnosticsFragment(diagnostics, folderUri?): ContextFragment | null`.
  - `function buildSymbolsFragment(symbols, folderUri?): ContextFragment | null`.
  - `function buildWorkspaceSymbolsFragment(symbols, folderUri?): ContextFragment | null`.
  - `function buildDefinitionsFragment(definitions, folderUri?): ContextFragment | null`.
  - `function buildReferencesFragment(references, folderUri?): ContextFragment | null`.
  - `function probeCapabilities(api, uri, timeoutMs?, signal?): Promise<LanguageCapabilities | null>`.
  - `interface SearchFallbackOptions { sourceId; priority; cwd?; maxResults?; folderUri?; allowPath? }`.
  - `function searchFallback(api, query, options, signal?): Promise<ContextFragment | null>`.
  - `interface LanguageSourceDeps { api; policy; folderUri?; cwd?; activeUri?; activePath?; activePosition?; openDocuments?; query?; probe?: (signal?) => Promise<LanguageCapabilities | null>; timeoutMs? }`.
  - `function createDiagnosticsSource(deps): ContextSource`.
  - `function createSymbolsSource(deps): ContextSource`.
  - `function createWorkspaceSymbolsSource(deps): ContextSource`.
  - `function createDefinitionsSource(deps): ContextSource`.
  - `function createReferencesSource(deps): ContextSource`.
  - `function createLanguageSources(deps): ContextSource[]` in reserved order: diagnostics, symbols, workspace-symbols, definitions, references.
- Exports from `extension/src/exec.ts`:
  - `function rg(args: string[], cwd: string, exec?: ExecFileLike): Promise<ExecResult>`.
  - `interface GitStatusEntry { status: string; path: string }`.
  - `type GitStatusResult = { ok: true; entries: GitStatusEntry[]; truncated: boolean } | { ok: false; code?: string; stderr: string }`.
  - `type GitChangedFilesResult = { ok: true; files: string[]; truncated: boolean } | { ok: false; code?: string; stderr: string }`.
  - `function gitStatus(cwd: string, exec?: ExecFileLike): Promise<GitStatusResult>`.
  - `function gitChangedFiles(cwd: string, exec?: ExecFileLike): Promise<GitChangedFilesResult>`.
  - `const MAX_GIT_ENTRIES = 200`.
- Exports from `extension/src/vscodeCodeTools.ts`:
  - `interface VscodeCodeToolsOptions { cwd?: string; rg?: typeof rg }`.
  - `function createVscodeCodeTools(options?): LanguageApi & { probe(uri, signal?): Promise<LanguageCapabilities | null>; openDocuments(): Array<{ uri: string; path: string }> }`.
  - This is the only file in #37 that imports `vscode`.
- Source ids and priorities:
  - `diagnostics` 45, `symbols` 40, `references` 39, `definitions` 38, `workspace-symbols` 37. The ids/priorities come from #36's `SOURCE_PRIORITIES`.
- Builder behavior:
  - Diagnostics: one line per diagnostic, `severity source path:range message`, newlines collapsed, cap 200, `truncated` when capped, `kind: "diagnostic"`.
  - Symbols: one line per document symbol; `path:line:col kind Container.name` when the path and range are known, otherwise `kind name`; cap 100; `kind: "symbol"`; `provenance.path` only when every included symbol is in the same known file.
  - Workspace symbols: one line per symbol `path:line:col kind Container.name`; cap 50; `kind: "workspace-symbol"`.
  - Definitions: one line per location `path:line:col name?`; cap 20; `kind: "definition"`.
  - References: one line per location `path:line:col name?`; cap 50; `kind: "reference"`.
  - Multi-result fragments omit `provenance.range`. All builders set `tokens = estimateTokens(content)`, `provenance.chars`, `provenance.truncated`, and `folderUri` when present. They leave `redactions` undefined for #36 to redact.
  - Positions are 0-based in the port and 1-based in the displayed `line:col`.
- Capability probe:
  - `probeCapabilities` returns null for an empty uri.
  - It calls each of the five LSP methods under a 3000 ms timeout and returns booleans. A sync throw, a rejection, or a timeout is false. The full lists are discarded.
  - The signal rejects the whole probe with `code: "cancelled"`.
  - The adapter's `probe(uri, signal?)` requires an open document; no open document returns null. It caches one entry per uri with `{ version, capabilities }`; the same document version hits, a version bump recomputes, and a version seen again recomputes. The cache is bounded by the number of open documents, not the number of edits.
  - Activation is the caller's non-blocking job; this ticket publishes the cached per-request probe.
- Text-search fallback:
  - `searchFallback` returns null for an empty/whitespace query.
  - It calls `api.textSearch(query, { cwd, maxResults })` under a 3000 ms timeout, with the cap clamped to `MAX_TEXT_SEARCH_MATCHES` (50).
  - It drops pathless, absolute, `..`, and `allowPath`-rejected matches.
  - No matches -> null. A fragment carries the replaced LSP source id/priority, `provenance.kind: "text-search"`, no range, and `truncated` when the match cap is hit.
  - `rg` missing (`ENOENT`) rethrows so the source can omit `unsupported`; other failures rethrow for `error`.
- Source behavior:
  - All sources `throwIfAborted(signal)` and use a 3000 ms provider timeout (`deps.timeoutMs` override for tests).
  - `diagnostics`: no open documents -> `empty`; documents filtered by `shouldInclude(path, "diagnostic", policy)`; all filtered -> `excluded`; probe false/null -> `unsupported`; provider throw/timeout -> `error`; zero diagnostics -> `empty`; cap 200; `details: { files, count, dropped }`.
  - `symbols`: no active uri/path -> `empty`; active path excluded by `shouldInclude(path, "active-file", policy)` -> `excluded`; probe false/null -> fallback/`unsupported`; LSP results filtered by `shouldInclude(path, "workspace", policy)`; cap 100; `details: { count, dropped }` or `{ count, dropped, textSearch: true }` on fallback.
  - `workspace-symbols`: no query -> `empty`; never calls the provider with an empty query; probe false/null -> fallback; LSP results filtered by `shouldInclude(path, "workspace", policy)`; cap 50; `details` as above.
  - `definitions`: no active uri/position -> `empty`; active path excluded -> `excluded`; probe false/null -> fallback/`unsupported`; locations filtered by `shouldInclude(path, "workspace", policy)`; cap 20; details as above.
  - `references`: same as definitions with cap 50.
  - A provider that answered but had every result filtered returns `empty` with `details: { count: 0, dropped: raw.length }`; it does not run the text-search fallback for hidden data.
  - A provider that answered with zero results falls back to text search when a query exists; otherwise `empty`/`unsupported`.
  - A fallback that finds no matches omits `empty`; a missing `rg` omits `unsupported`; another fallback failure omits `error`. An abort rejects.
- `exec.ts`:
  - `rg(args, cwd)` uses `execFile("rg", args, { cwd, timeout: 5000, maxBuffer: 1 MB })`. Exit code 1 with empty stderr is a successful empty result. A missing `rg` returns `code: "ENOENT"`. Other failures return `code` when it is a string and the stderr/error message. No shell.
  - `gitStatus(cwd)` uses `git status --porcelain=v1 -z`, parses NUL-separated rows, preserves spaces/newlines, skips the original-path segment after a rename/copy, caps at 200, and sets `truncated`.
  - `gitChangedFiles(cwd)` combines the status paths with the last five commits' NUL-separated `--name-only` names, unique and sorted, caps at 200, and sets `truncated` when either the status or the combined list was capped. A log failure keeps the status paths.
- `vscodeCodeTools.ts`:
  - Converts `DocumentSymbol` (children flattened), `SymbolInformation`, `Location`, `LocationLink` (target selection range preferred), `Diagnostic` (severity name, source, range, message), and `Uri`/`Position`/`Range`.
  - `textSearch` runs `rg --json` with the cwd, parses match lines, builds file URIs, drops absolute/`..` paths, and caps. Missing rg and other failures throw with the code.
  - `openDocuments()` returns file-scheme open documents as `{ uri, path }`.
  - The adapter caches the probe per uri and document version.
- Docs:
  - `docs/lsp-parity.md` records the environment facts, the three languages (TypeScript, Python, Rust), a table with provider availability/symbol kind/location precision/truncation, and the exact manual steps. All rows are marked **not measured** because no interactive VS Code window was available. `rg` is not installed on this machine.
- Tests:
  - `extension/test/languageContext.test.ts`: `npx vitest run extension/test/languageContext.test.ts` -> 100 passed.
  - `extension/test/vscodeCodeTools.test.ts`: `npx vitest run extension/test/vscodeCodeTools.test.ts` -> 20 passed.
  - Full suite: `npm test` -> 442 passed.
- Test seams:
  - `LanguageApi` port with a fake: `extension/test/languageContext.test.ts`.
  - Builders: `extension/test/languageContext.test.ts`.
  - `probeCapabilities`: `extension/test/languageContext.test.ts`.
  - `searchFallback`: `extension/test/languageContext.test.ts`.
  - Sources: `extension/test/languageContext.test.ts`.
  - `exec.ts` helpers with a fake executor: `extension/test/languageContext.test.ts`.
  - Adapter with a stubbed `vscode`: `extension/test/vscodeCodeTools.test.ts`. This is the only test that mocks `vscode`.
- Edge modes covered:
  - No active editor/position, untitled/virtual, no query, empty provider results, zero diagnostics, 10k diagnostics/symbols capped, locations outside the workspace dropped, provider throw/timeout, abort, `rg` missing, git missing/not a repo, paths with spaces/newlines, renames, ignored paths, `.gitignore`, multi-root caller-provided cwd, deleted/pathless results dropped.
- Assumptions:
  - `DocumentSymbol` and `SymbolInformation` results both arrive from `vscode.executeDocumentSymbolProvider`; the adapter handles both. `LocationLink` prefers `targetSelectionRange`.
  - The probe calls all five providers with a sentinel `"probe"` workspace query and discards the lists; the result is booleans only. This costs five provider calls per uncached document version; the adapter caches.
  - `deps.probe` is optional. When absent, the source calls the LSP directly; when null/false, it uses the fallback.
  - The diagnostics source returns `excluded` when open documents exist but all fail `shouldInclude`.
  - The bundled `@vscode/ripgrep` binary is copied to `extension/dist/rg`; no system `rg` is needed.
  - The e2e suite measures TypeScript; Python and Rust remain manual in `docs/lsp-parity.md`.
  - The workspace-boundary helper is #41's `isOutsideWorkspace`; this module and the adapter import it from `./privacy`.
- Consumers:
  - #46: wire `createLanguageSources` into the assembler with the adapter, the resolved folder/policy, the active uri/path/position, open documents, the query, and the cached `probe`. The deep prompt receives the fragments; #36 redacts and budgets them.
  - #36: no change; the language sources use the reserved ids/priorities and return `ContextSourceResult`.
  - #18: use `LanguageApi`/builders for codebase access experiments.
  - #4: use the parity record and fallback behavior for few-shot task detection.
- Open gaps:
  - LSP parity is measured by the e2e TypeScript tests; Python and Rust remain manual in `docs/lsp-parity.md`.
  - The bundled `rg` is exercised by the e2e suite; no system install is needed.
  - The probe makes five provider calls per uncached version; large workspaces may want a cheaper provider-availability check.
  - No separate workspace-boundary copy remains; #41 exports the shared helper.
- Change log:
  - v1: initial contract merged in #37.

<a id="contract-38"></a>

## Contract: #38 Current session slice reader - v1

> **Superseded in v2:** the fields and seams in "Contract deltas in detail" win.
> The text below is retained as the v1 record.


- State: merged.
- Commit: `e366d25df10a700bae886d3af3d342afe959455d`.
- Base: `d34bd22`.
- Exports from `extension/src/sessionLocator.ts`:
  - `type SessionProvider = "claude" | "codex"`.
  - `interface SessionCandidate { sessionId: string; provider: SessionProvider; folderUri: string; filePath: string; mtimeMs: number; startedAt?: string; turnCount?: number }`.
  - `interface LocatorInput { sendId?: string; folderUri: string; promptHash?: string; sends: Array<Event<SendRecord>>; candidates: SessionCandidate[]; clock: Clock }`.
  - `type SessionLocation = { kind: "found"; candidate: SessionCandidate } | { kind: "ambiguous"; candidates: SessionCandidate[] } | { kind: "none" }`.
  - `const SEND_MATCH_WINDOW_MS = 1800000`, `SESSION_AGE_WINDOW_MS = 86400000`, `AMBIGUITY_WINDOW_MS = 120000`.
  - `function canonicalFolderUri(uri: string): string`.
  - `function locateSession(input: LocatorInput): SessionLocation`.
- Exports from `extension/src/sessionSlice.ts`:
  - `interface SessionCaps { maxTurns: number; maxTokens: number; maxBytes: number }`.
  - `const DEFAULT_SESSION_CAPS = { maxTurns: 10, maxTokens: 8000, maxBytes: 5000000 }`.
  - `interface Turn { role: "user" | "assistant"; text: string; at?: string; code?: string[]; codePath?: string }` (`codePath` is the additive field required by #41's per-file code policy).
  - `interface ToolCall { name: string; status: "ok" | "error" | "unknown"; summary: string; at?: string }`.
  - `interface SessionError { message: string; status: "error" | "resolved" | "unknown"; at?: string }`.
  - `interface TestResult { name: string; status: "passed" | "failed" | "skipped" | "unknown"; at?: string }`.
  - `interface SessionProvenance { sourcePath: string; bytesRead: number; turnsKept: number; truncated: boolean; droppedTurns: number; droppedToolCalls: number; droppedFiles: number; redactions: number; reason?: "unsupported" | "empty" | "error" }`.
  - `interface SessionSlice { sessionId: string; provider: SessionProvider; folderUri: string; startedAt: string | null; endedAt: string | null; turns: Turn[]; toolCalls: ToolCall[]; errors: SessionError[]; testResults: TestResult[]; changedFiles: string[]; tokens: number; truncated: boolean; provenance: SessionProvenance }`.
  - `interface ParsedSession { sessionId?: string; folderUri?: string; startedAt?: string; endedAt?: string; turns: Turn[]; toolCalls: ToolCall[]; errors: SessionError[]; testResults: TestResult[]; changedFiles: string[] }`.
  - `function parseClaudeSession(text: string): ParsedSession`.
  - `function parseCodexSession(text: string): ParsedSession`.
  - `interface SliceOptions { includeCode: IncludeCode; activeFileUri?: string; redact(text: string): { text: string; count: number } }`.
  - `function readSlice(filePath: string, provider: SessionProvider, caps: SessionCaps, clock: Clock, options: SliceOptions): Promise<SessionSlice>`.
  - `async function discoverCandidates(folderUri: string, homeDir: string): Promise<SessionCandidate[]>`.
  - `function formatSessionSlice(slice: SessionSlice): string`.
  - `interface SessionSliceSourceDeps { folderUri: string; homeDir?: string; candidates?: SessionCandidate[]; sends: Array<Event<SendRecord>>; sendId?: string; promptHash?: string; clock: Clock; caps?: SessionCaps; capabilities?: ModelCapabilities; includeCode: IncludeCode; activeFileUri?: string; redact(text: string): { text: string; count: number } }`.
  - `function createSessionSliceSource(deps: SessionSliceSourceDeps): ContextSource` with id `session-slice` and priority 85.
- Locator:
  - `sends` is folded by envelope `id` to the highest `seq`.
  - Path 1: the latest send with `id === sendId`. If it has no `sessionId`, fall through to path 2. If it has one, a candidate with that `sessionId` and the canonical send folder URI wins. If absent, `none`; never link a different session.
  - Path 2: only when `promptHash` is present. Sends with the canonical input folder URI, a matching `promptHash`, and `Date.parse(ts) >= clock.now() - 30 minutes`. The latest by `ts`, then `seq`. A candidate for its `sessionId`/folder wins; a missing candidate or missing `sessionId` falls through to path 3.
  - Path 3: candidates with the canonical input folder and `mtimeMs >= clock.now() - 24 hours`. None -> `none`. The latest mtime. If at least two candidates are within 2 minutes of it, return `ambiguous` sorted by mtime descending and `sessionId` ascending. Otherwise `found` the latest.
  - `canonicalFolderUri` round-trips file URIs through `fileURLToPath`/`pathToFileURL` and strips one trailing separator; non-file URIs pass through.
  - The locator is pure, uses only the injected `Clock`, and has no filesystem access.
- Discovery:
  - Claude sessions live under `~/.claude/projects/<encoded-workspace-path>/*.jsonl`. On POSIX the absolute workspace path has its path separators replaced by `-`; the current environment encodes `/Users/diekgbbtt/preFlight` as `-Users-diekgbbtt-preFlight` (verified against directory names only). The Windows drive/separator encoding is a recorded gap, not guessed.
  - Codex sessions live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Discovery searches recursively and filters by the `session_meta` `cwd` metadata, not a flat directory.
  - `discoverCandidates(folderUri, homeDir)` takes an injected home directory. Missing provider directories -> `[]`; permission errors throw so the source/assembler can record `error`. Tests use fixture home directories; the real home is never read in tests.
  - `SessionCandidate` carries `sessionId`, `provider`, canonical `folderUri`, `filePath`, `mtimeMs`, and optional `startedAt`/`turnCount`.
  - The tests use synthetic fixtures only; no real session content is copied into the repository.
- Bounded read:
  - `readSlice` stats the file, starts at `max(0, size - maxBytes)`, reads with `fs.open`/`fs.read` in a loop until the window is filled or EOF, and records the actual `bytesRead`.
  - A seek that lands mid-line drops the partial first line. A seek that lands on a line boundary keeps the first complete line. A final line without a trailing newline is dropped. No `readFile` of the whole file. No partial line is parsed.
  - 5 MB exactly is read in full with `truncated` false from the byte window; one byte over starts mid-window and sets `truncated` true.
- Parsers:
  - `parseClaudeSession` and `parseCodexSession` take complete-line text, skip empty/corrupt/malformed lines, and never throw.
  - Claude public format: `type: user|assistant`, `message.role`, `message.content` (string or blocks), `timestamp`, `cwd`, `sessionId`. Text blocks become turns; `tool_use`/`tool_result` pairs become tool calls with ok/error status; failed results become `SessionError`s; test commands become `TestResult`s with final status; mutation tool inputs (`file_path`/`path`/`notebook_path`) become changed files; fenced code is extracted into `Turn.code` with a `codePath` and removed from the turn text; thinking blocks are ignored.
  - Codex public format: `session_meta` (id/timestamp/cwd), `response_item` messages (`input_text`/`output_text`), `function_call`/`function_call_output`, and `event_msg` `exec_command_begin`/`exec_command_end` when present. Unknown event types are skipped. The synthetic fixtures record the assumed fields.
  - Consecutive same-role messages merge into one turn. Tool calls are matched to turns by timestamp for retention. Errors resolve when a later tool call succeeds. Test results dedupe by command name and keep the final status. A tool-only assistant turn is retained so its calls are not lost.
  - Code without a resolvable path is dropped in every mode (fail-closed). Mixed-path fences split into code-only turns with their own `codePath`.
- Slice:
  - Last `caps.maxTurns` turns, then drop the oldest turns while the total token estimate (turn text + retained code + retained tool-call summaries + error messages + test-result names) exceeds `caps.maxTokens`.
  - `tokens` is the final estimate over the retained content. One turn alone over the cap returns an empty slice with `truncated: true` and the drop counts.
  - `changedFiles` is resolved against the session cwd, workspace-relative POSIX, sorted; absolute/`..` paths are dropped and counted in `droppedFiles`.
  - `provenance` records `sourcePath`, actual `bytesRead`, `turnsKept`, `truncated`, `droppedTurns`, `droppedToolCalls`, `droppedFiles`, `redactions`, and `reason` when the slice is empty/unsupported/error.
  - `truncated` is true when the byte window starts after 0, when any turn is dropped, or when any tool call is dropped.
  - Errors and test results are global and are not dropped by the turn cap. If they alone exceed `maxTokens`, the reader returns the empty truncated slice. The documented behavior is in the code comment.
  - Unknown provider -> empty slice with `reason: "unsupported"`. Missing/unreadable file -> `reason: "error"`. Empty/unparseable -> `reason: "empty"`. No throw.
- Privacy:
  - `includeCode: off` keeps turn text and changed-file paths but drops every code excerpt.
  - `includeCode: active-file` keeps code only when the turn's `codePath` resolves to the same workspace-relative path as `activeFileUri` and #41's `shouldInclude(path, "active-file", { includeCode: "active-file", activePath })` passes. No active file -> drop all code.
  - `includeCode: workspace` keeps code only when `shouldInclude(path, "workspace", { includeCode: "workspace" })` passes.
  - `redact` is applied to turn text, code, tool-call summaries, error messages, and test-result names before the budget and before returning. Summed counts go to `provenance.redactions`. The reader never logs the original text or a secret.
  - The slice never contains the raw transcript. #38 does not write files and does not persist anything.
- Session-slice source:
  - `createSessionSliceSource` returns a `ContextSource` with id `session-slice`, priority 85.
  - It uses `deps.candidates` when supplied; otherwise `discoverCandidates(deps.folderUri, deps.homeDir ?? os.homedir())`.
  - It calls `locateSession`. `none` -> `empty` with `details: { resolved: "none" }`. `ambiguous` -> `empty` with `details: { ambiguous: n }`; the caller owns the picker and can call `locateSession` directly for the candidates. `found` -> `readSlice`.
  - `caps.maxTokens` is capped to `deps.capabilities.maxContextTokens` when that is positive and finite. The source does not use a `ModelProfile` field; the capability comes from #39's provider.
  - On a slice reason `unsupported`/`error`/`empty`, the source returns the matching `omittedReason` with details. On success it formats the slice and returns one fragment with `kind: "session"`, `truncated`, `chars`, `redactions` copied from the slice, `folderUri`, and `tokens = estimateTokens(formattedContent)` (not `slice.tokens`).
  - `details` contains `sourcePath`, `bytesRead`, `turnsKept`, `truncated`, `redactions`, `droppedTurns`, `droppedToolCalls`, `droppedFiles`, and `reason` when present.
- Tests:
  - `extension/test/sessionLocator.test.ts`: `npx vitest run extension/test/sessionLocator.test.ts` -> 18 passed.
  - `extension/test/sessionSlice.test.ts`: `npx vitest run extension/test/sessionSlice.test.ts` -> 58 passed.
  - Full suite: `npm test` -> 518 passed.
- Test seams:
  - `locateSession`: `extension/test/sessionLocator.test.ts`, including `hashPrompt` from #40 for the prompt hash.
  - `discoverCandidates`: `extension/test/sessionSlice.test.ts` with fixture home directories.
  - `readSlice`: `extension/test/sessionSlice.test.ts` with fixture/temp files.
  - `parseClaudeSession`/`parseCodexSession`: `extension/test/sessionSlice.test.ts` with synthetic fixtures.
  - `createSessionSliceSource`: `extension/test/sessionSlice.test.ts` with fake candidates/sends/clock/redact.
  - No real home, no vscode mock, no internal module mocks.
- Edge modes covered:
  - Missing provider dirs, permission denied discovery, empty/corrupt/binary files, trailing partial lines, 5 MB exact/one over, mid-line and line-boundary seeks.
  - sendId path with a missing linked file -> none; send versions folded by seq; hash window 30 minutes; missing hash candidate -> recency; 24-hour recency; 2-minute ambiguity and sort; clock skew; multi-root/canonical URIs.
  - 10/11 turns; one turn over the token cap -> empty truncated; token cap including calls/errors/tests; tool-only turns; orphan failed results; changed files only from mutation tools; outside paths dropped.
  - includeCode off/active/workspace; excluded code paths; code without a path dropped; secrets in turn text, code, tool summaries, errors, and tests redacted and counted; non-English text preserved.
  - Codex nested date directories; Codex `event_msg` exec begin/end; unknown event types skipped.
- Assumptions:
  - The Claude POSIX encoding is path separators -> `-`. The Windows encoding is not measured and is a recorded gap.
  - The Codex layout and JSONL field names are the public rollout format; the synthetic fixtures record the assumed fields. Additional real-world fields are ignored defensively.
  - `Turn.codePath` is an additive field required by #41's per-file code policy. It is the workspace-relative path of the code in that turn.
  - `SessionSliceSourceDeps.capabilities` is the #39 provider's `ModelCapabilities`; `ModelProfile` alone has no capabilities. The source uses `capabilities.maxContextTokens`.
  - Consecutive same-role messages merge into one turn. Tool calls are retained by timestamp ownership. Errors resolve on a later successful call. Test results dedupe by command name and keep the final status.
  - The source returns `empty` with `details` on ambiguity; the caller owns the picker. #38 does not import `vscode`.
  - Claude discovery does not populate `startedAt`/`turnCount`; the candidate fields are optional and `readSlice` fills the slice's start/end from the window. The caller can read the candidate for the picker.
  - A live session's trailing partial line is never parsed; the freshest write can lag by one line. This is the required partial-line rule.
  - The `readSlice` `clock` parameter is currently unused; it is kept in the published signature for the time-based slice consumers/tests.
  - A send id with no matching `SendRecord` falls through to path 2/3; the ticket defines the no-`sessionId` and missing-file cases only.
- Consumers:
  - #46: create the session-slice source with the resolved folder, the draft, the send records, the send id, the prompt hash, the clock, the provider capabilities, the includeCode policy, the active file URI, and #41's `redact`. Use `locateSession` directly when the source reports ambiguity and the picker is needed. Store the derived slice in the review record; never the transcript.
  - #47: render the slice fields and provenance in the deep review view.
  - #13: use the slice in the deep prompt; the fragment is already redacted and #36 will not double-count it.
  - #18: use the slice as bounded session context in the codebase-access experiment.
  - #1: the token estimate and usage fields can inform agent usage reporting.
- Open gaps:
  - LSP parity is measured by the e2e TypeScript tests; Python and Rust remain manual. The bundled `rg` needs no system install.
  - The Windows Claude encoding is not measured.
  - Claude discovery leaves `startedAt`/`turnCount` undefined; the picker caller can enrich them.
  - A live session's newest line can lag by one write because trailing partial lines are dropped.
  - The parser field names for the Codex `event_msg` exec events are the assumed public fields; real-world extra fields are ignored.
- Change log:
  - v1: initial contract merged in #38.

## Contract changes

| Date | Contract | From | To | Consumers notified |
|---|---|---|---|---|
| 2026-11-16 | #40 review schema | none | v1 | #26, #27, #35, #36, #38, #39, #42, #45, #13, #46 |
| 2026-11-16 | #41 privacy boundary | none | v1 | #36, #38, #13, #46 |
| 2026-11-16 | #41 privacy boundary | v1 | v1.1 | #36, #37, #38, #13, #46; additive `isOutsideWorkspace` export |
| 2026-11-16 | #35 JSONL repository | none | v1 | #38, #43, #45, #46, #15 |
| 2026-11-16 | #39 model profiles | none | v1 | #42, #26, #46, #10, #12, #45, #38, #6, #22, #27 |
| 2026-11-16 | #39 model profiles | v1 | v1.1 | #42, #43, #46; additive `claudeCliRunner` effort parameter, no break |
| 2026-11-16 | #42 feedback errors | none | v1 | #27, #43, #46, #47, #10, #12, #22 |
| 2026-11-16 | #36 context assembler | none | v1 | #37, #38, #46, #48, #13 |
| 2026-11-16 | #37 language context | none | v1 | #46, #18, #4, #36 |
| 2026-11-16 | #38 session slice | none | v1 | #46, #47, #13, #18, #1 |

## Dispatch notes

- The default provider balance was exhausted during lane 1.
- The free-model fallback also reached its usage limit.
- All implementer and reviewer dispatches after #40 used `opencode-go/glm-5.3-flash`.
- No task scope or acceptance criterion changed because of the model fallback.

## E2E harness

The e2e tier mounts the built extension in a real VS Code extension host.

- Launcher: `e2e/run.mjs`.
- Extension-host suite: `e2e/suite/index.ts`.
- Test facade: `e2e/facade.ts`.
- Sample workspace: `e2e/fixture`.
- Command: `npm run e2e`.
- Dry run that builds the suite and prints the launch command: `node e2e/run.mjs --dry-run`.
- Override the binary with `VSCODE_BIN`.
- Keep the temp workspace with `PREFLIGHT_E2E_KEEP=1`.

The suite asserts:

- E1: `@src/greet.ts` enters the bundle as `prompt-files` and no active-editor source exists.
- E2: quick score 90; deep review has no score and no improved prompt; the separate action returns `[expected result]`; the review event has neither field.
- E3: `includeCode: "off"` excludes the file and never calls the reader.
- E4: `sends.jsonl` stores the exact text and the shared prompt hash at seq 1.
- E5: the Claude fixture slice keeps code only for `src/greet.ts`.
- E6: the real Codex fixture yields two calls, a failed test, one error, and `src/app.ts`.
- E7: the TypeScript provider returns the `greet` symbol.
- E8: an absent workspace symbol falls over to the bundled `rg`.
- E9: a missing CLI maps to `provider-missing`.

The live edge is the fake Claude CLI and the built-in TypeScript provider.
The fixture workspace is copied to a temp directory; the seeded session homes are temp directories.

### E2E status

- The suite builds: `e2e/dist/suite.cjs` is about 398 kB.
- The fixture workspace and session homes are created by the launcher.
- The local launch is blocked in the current agent sandbox: `/Applications/Visual Studio Code.app/Contents/MacOS/Code` exits with code 134 before any output.
- `codesign --verify --deep --strict` reports the installed app signature as invalid.
- An ad-hoc signed copy still exits 134.
- Run `npm run e2e` from a normal GUI Terminal, or set `VSCODE_BIN` to a working VS Code executable.
- The first e2e run passed 8 of 9 tests. E8 failed because rg read stdin instead of the workspace; the adapter now passes an explicit `.` search path.
- The rerun passed all 9 tests on 2026-11-17.

## Change log for the review fixes

- #40 v2: provider-native effort, caps 20, no deep score, no deep improved prompt, separate `ImprovedPrompt`.
- #39 v1.2: effort string pass-through.
- #36 v2: explicit `@` files replace active, selection, and open editors.
- #41 v2: `prompt-files` policy and legacy `active-file` mapping.
- #37 v2: agent tools over LSP types with a bundled-rg fallback.
- #38 v2: real Codex `item_completed` events and Windows path rules.
