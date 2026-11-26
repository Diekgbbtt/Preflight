# Lane 2 handoff ledger (deep feedback)

This ledger holds the lane 2 contracts for consumers in lanes 1, 3 and 4, and for the panel work that follows #55. Every contract has a version and a change log. A change to a contract adds a change-log row here, in the same PR.

Lane 2 tickets (#28): #46, #13, #48, #18, #15, #47, #16.

## Status

All lane 2 PRs are drafts. None is merged yet.

| Ticket | PR | Branch | Tip | State | Waiting on |
|---|---|---|---|---|---|
| #18 codebase access (decision) | #57 | `lane-2/18-code-access` | `3c6fc06` | Done; closes #18 | Review |
| #18 re-run with `deep-v2` | #62 | `lane-2/18-recheck` | `c38c3b3` | Done | Review; merges #57's branch |
| #46 deep contract (core) | #58 | `lane-2/46-deep-contract` | `7cbc4ed` | Core done; part of #46 | #56 (lane 1); panel restore needs #43 |
| #13 deep prompt | #59 | `lane-2/13-deep-prompt` | `5b13df3` | Done | #58 |
| #48 instruction files | #60 | `lane-2/48-instruction-files` | `9be0f10` | Done; closes #48 | #59 |
| #16 step 1 (grounded options) | #63 | `lane-2/16-grounded-options` | `b379039` | Evaluated | Clarification by the ticket author; #15 |
| #15 questions (core) | #64 | `lane-2/15-questions-core` | `73d9a90` | Core done; part of #15 | #60; panel needs #55 |
| #47 deep review view (core) | #65 | `lane-2/47-deep-view` | `528be80` | Core done; part of #47 | #64; webview needs #55 |

**Stack:** #58 ← #59 ← #60 ← #64 ← #65 (product code). #62 and #63 hang off #60 (evaluations only). #57 stands alone.

Each PR runs `npm run typecheck && npm test && npm run build`. At #65: 645 tests.

## Contracts

### C1 `deepFeedback` (#46): v1

File: `core/src/deepFeedback.ts`. No VS Code imports.

```ts
deepFeedback(input: DeepFeedbackInput, deps: DeepFeedbackDeps, signal?): Promise<DeepFeedbackResult>
DeepFeedbackInput = { draftId; draft; folders: string[] /* folder URIs */; sessionId? /* agent session */ }
DeepFeedbackDeps  = { provider; model; clock; ids; reviews: Repository<DeepReviewRecord>; questions: Repository<Question>;
                      sources(draft): ContextSource[] | Promise<…>; redact; estimateTokens?;
                      instructions?: InstructionLoader; instructionConfig?: InstructionLoaderConfig }
DeepFeedbackResult = { ok: true; reviewId; review: DeepReviewRecord } | { ok: false; error: FeedbackError }
loadDeepSession(draftId, { reviews, questions }) → { latest: Event<DeepReviewRecord> | null; questions: Event<Question>[] }
qaFrom(questions) → Array<{ question; answer }>
```

**One round:**

1. An empty or whitespace-only draft makes no model call. It stores a review with one question (`EMPTY_DRAFT_QUESTION`).
2. Load instructions only when `provider.capabilities.supportsInstructionFiles`, a loader is set, and `instructionConfig.shareCode` is true.
   - Unsupported: the gap `NO_INSTRUCTION_CONTROL_GAP`.
   - Not shared: the gap `INSTRUCTIONS_NOT_SHARED_GAP`.
3. Run `assemble` with `{ draft, qa: qaFrom(questions) }` and the instruction files as `extraEntries`.
4. Run `exceedsBudget` / `exceedsContext`. On failure, return `context-too-large` without a model call.
5. Call `buildDeepPrompt`, then `provider.complete` once.
6. Run `restoreMentions` on the reply. A reply without `issues` and `questions` arrays is `invalid-response`.
7. Run `parseDeepReview`. Add code-generated `contextGaps` from `manifestGaps`.
8. Append to `reviews.jsonl` (envelope id = `reviewId`), and one event per question to `questions.jsonl`.

**`DeepReviewRecord`** = `DeepReview` (lane 1 v2: no score, no `improvedPrompt`) plus:

- `draftId`;
- `promptHash` (`hashPrompt(draft)`, C5);
- `sessionId?` (the agent session, as in `SendRecord`);
- `contextManifest`;
- `sessionSlice?`: `{ content, tokens, truncated }`, the redacted slice text the model saw. `SessionSlice` itself is an extension type.

**A feedback session is one draft:** everything is keyed by `draftId`. `sessionId` keeps its #35 meaning (the agent session).

**Shared plain wording**, used by `manifestGaps` and C5:

- `sourceName(id)`;
- `OMIT_REASONS`;
- `promptFileFacts(details)`.

### C2 `buildDeepPrompt` (#13): `deep-v2`

File: `core/src/deepPrompt.ts`. Pure.

```ts
buildDeepPrompt({ bundle }: DeepFeedbackRequest, instructionText = "") → { system; user; promptVersion /* DEEP_PROMPT_VERSION = "deep-v2" */ }
neutralizeMentions(text) / restoreMentions(text)
```

- **System order:**
  1. Role;
  2. Silent checks and limits (at most 3 issues, at most 3 questions with at most 3 options, at most 5 assumptions, at most 5 gaps; "never fill a limit");
  3. `RUBRIC_TEXT`;
  4. Instruction block, only when non-empty;
  5. `DEEP_REPLY_SCHEMA` (unchanged);
  6. Rules and edge cases;
  7. Three examples.
- **User order:** `<manifest>`, `<workspace>`, `<session>`, `<qa>`, `<draft>`. Empty sections are left out.
- **#56 safeguard:** a zero-width space after every `@` in the user message and in the instruction text.
- **Version guard:** `core/test/deepPrompt.test.ts` stores a hash of the system text per version. Changing the text means bumping `DEEP_PROMPT_VERSION` and adding a hash.
- **The model does not report manifest facts.** Missing, left-out and cut sources come from the code (C1). The model reports conflicts between instruction files without naming a winner, and never reports that files agree.

### C3 Instruction and design files (#48): v1

Port in `core/src/deepFeedback.ts`; implementation in `extension/src/instructionFiles.ts`.

```ts
InstructionLoader.load(folders: string[], draft, config: InstructionLoaderConfig) → InstructionBlock { text; files: InstructionFile[] }
InstructionLoaderConfig = { instructionFileNames: string[]; designFileNames?: string[]; shareCode: boolean }
InstructionFile = { displayPath; relativePath; folder; bytes; tokens; included; truncated; redactions; kind?: "instructions" | "docs" }
createInstructionLoader(overrides?) · readInstructionConfig(shareCode)
```

**Settings:**

- `promptPreflight.context.instructionFileNames`, default `["AGENTS.md", "CLAUDE.md"]`;
- `promptPreflight.context.designFileNames`, default `[]`.

Both take basenames only. Glob characters are rejected.

**Discovery:**

- `findFiles` per folder, so `files.exclude` applies. `.git` and `node_modules` are dropped.
- Deduplicated by `realpath`. A symlink pointing outside the folder is rejected.
- `shareCode: false` returns an empty block without touching the disk.

**Block:**

- **Header:** the #48 header with one `displayPath` per line. Control characters in names are escaped.
- **Tags:** `<project-instructions nonce="…" path="…">`, or `<project-docs …>` for design files.
- **Nonce:** one per request. A copy of the nonce inside a file is replaced with `[redacted-nonce]`.
- **Budget:** 2,000 tokens per file and 8,000 in total. Nearest instruction file first, then the other instruction files, then design files.
- **Truncation:** at a line boundary, with `truncated="true"`.

**Manifest ids:** `instructions:<displayPath>` and `docs:<displayPath>`. `@` imports inside `CLAUDE.md` are not followed.

### C4 Questions and answers (#15): v1

Files: `core/src/questions.ts` and `Question` in `core/src/deepFeedback.ts`.

```ts
Question = { draftId; sessionId?; reviewId; question; why; options /* ≤ 3 */; answer?: { text; option?; answeredAt }; skippedAt? }
isOpen · openQuestions · answerEvent(question, input: AnswerInput, nowIso) · parseAnswersMessage(raw, { draftId, open })
AnswerInput = { id; text; option? } | { id; skip: true }
```

- **Events:** answering or skipping appends a new event with the **same question id**. The latest event per id wins.
- **Closed questions:** an answered or skipped question stays closed in v1. A blank answer counts as no answer.
- **Q&A for the next round (`qaFrom`):**
  - answered questions with their text;
  - skipped questions as `SKIPPED_ANSWER` ("The user chose not to answer this.");
  - untouched questions are not sent.
- **Trust boundary:** `parseAnswersMessage` checks the webview message `{ type: "answers", draftId, answers }`.
  - **All or nothing:** one bad entry rejects the whole message.
  - **Text:** free text wins over an option, and an option alone answers with its own text. Text is at most `MAX_ANSWER_CHARS` (2,000) characters.
  - **Reasons:** short codes, never answer text.
- **Panel messages** (posted on #15, not yet wired):
  - `{ type: "questions", draftId, items }` (host → webview);
  - `{ type: "answers", draftId, answers }` (webview → host).

### C5 Deep review view (#47): v1

File: `core/src/deepView.ts`. Pure.

```ts
deepReviewView({ review, questions, draft, running?, error? }) → DeepView
DeepView = { state: "none" | "running" | "ready" | "stale" | "error"; madeAt?; issues; openQuestions; assumptions; contextGaps;
             qaHistory: QaItem[]; manifest: { rows: ManifestRow[]; totalTokens; budget } | null; actionable; canImprove; error? }
manifestRows(manifest) → ManifestRow[] /* { label; tokens; status: "included" | "cut" | "left out"; reason?; facts } */
```

- **State priority:** `running` > `error` > `none` > `stale` > `ready`. Stale means `promptHash ≠ hashPrompt(currentDraft)`, and a review without a hash counts as stale.
- **Actions:** `actionable` only in `ready`. `canImprove` requires `ready` and at least one question.
- **Questions:** `openQuestions` covers the latest review only. `qaHistory` covers every answered or skipped question of the draft, oldest first.
- **Errors:** an error has exactly one action, from `feedbackMessage` and `ACTION_LABELS`.
- **No score:** the deep review has none (lane 1 v2). The quick score belongs to lane 3 (#27).

### C6 Deep review context (#46 / #18): v1

File: `extension/src/deepContext.ts`. Not wired into the panel yet.

```ts
deepSources(draft, { folders, includeCode /* consented */, notes, sends, sendId?, clock, capabilities, rgPath? }) → ContextSource[]
```

- **Sources:** T0 and T1 from the #18 decision: file-name notes, `@` files, git diff, symbols, diagnostics, session slice. No workspace search (T2) and no model tools.
- **Order:** `@` references are resolved first, so one list feeds every policy.
- **Shortcuts, marked in the code:**
  - git diff, code tools and the session slice use the first workspace folder;
  - symbols cover the first referenced file.

## Decisions

| Ticket | Decision | Document |
|---|---|---|
| #18 | Preflight selects the code (T0 and T1); no model tools; T2 off until a larger evaluation and #61 | `docs/decisions/deep-feedback-code-access.md` (#57, revised in #62) |
| #16 | No agent loop for now; grounded options only for remaining lookup questions; reading A not yet confirmed | `docs/decisions/grounded-question-options.md` (#63) |

Evaluation data is under `docs/measurements/code-access-2026-11-24*`, `grounded-options-2026-11-24` and `live-check-{46,13,48}-2026-11-24`. Scripts are in `scripts/`.

## Findings reported to other lanes

| Issue | Lane | Gist | Lane 2 safeguard |
|---|---|---|---|
| #56 | 1 | The Claude CLI reads `@file` mentions in the prompt itself, outside the privacy policy (a `.env` file included). The working directory also reaches the model | `neutralizeMentions` in C2 (deep path only). #58 should merge after #56 |
| #61 | 1 | The text-search fallback caps before the privacy filter and is not deterministic | C6 passes no query, so it does not reach the fallback. T2 stays off |

## Open

- **Panel wiring** for C1, C4, C5 and C6: question cards, Submit/Skip, the manifest drawer, stale and error states, draft id and `setState` restore. All wait for #55.
- **`FeedbackService.deep()`**, a thin wrapper over C1, once #55 adds `FeedbackService`.
- **Panel restore through `PromptService`** (#43, lane 4, unassigned).
- **The meaning of #16**, asked on the ticket.
- **#59's PR text** has no closing keyword for #13.

## Change log

| Date | Contract | From | To | Change |
|---|---|---|---|---|
| 2026-11-24 | C1 `deepFeedback` | none | v1 | Initial (#58) |
| 2026-11-24 | C2 `buildDeepPrompt` | none | deep-v1 | Signature and section order (#58) |
| 2026-11-24 | C2 `buildDeepPrompt` | deep-v1 | deep-v2 | Prompt text, limits, edge cases, examples; empty draft skips the model (#59) |
| 2026-11-24 | C3 instruction files | none | v1 | Loader, settings, `kind`, `shareCode` and the consent gap (#60) |
| 2026-11-26 | C4 questions | none | v1 | Answers, skips, `parseAnswersMessage` (#64) |
| 2026-11-26 | C4 questions | v1 | v1 | `isOpen` treats a blank answer as no answer (#64, `73d9a90`) |
| 2026-11-26 | C1 `deepFeedback` | v1 | v1 | Additive: `DeepReviewRecord.promptHash`; `sourceName`, `OMIT_REASONS`, `promptFileFacts` exported (#65) |
| 2026-11-26 | C5 deep review view | none | v1 | Initial (#65) |
| 2026-11-26 | C6 deep review context | none | v1 | Recorded as a contract (code from #58) |
