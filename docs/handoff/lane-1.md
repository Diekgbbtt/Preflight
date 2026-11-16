# Lane 1 handoff ledger

The ledger is the only cross-ticket memory for Lane 1.
It is authoritative for consumers in lanes 2, 3, and 4.
Every entry has a contract version and a change log.

## Status

| Ticket | State | Branch | Commit | Tests | Reviewer |
|---|---|---|---|---|---|
| #40 | merged | ticket/40-review-schema | cf5cdbbcacbb73468dc8b8c0d90eb41eb59bc622 | `npm run typecheck && npm test && npm run build` -> 111 passed | PASS |

Source branch: `lane-1/control-plane`.
Setup commit: `098e887` (`chore: set up lane 1 worktrees and extension tests`).
Lane base for ticket #40: `098e8873371ef995ba7cb1a2ddbd50a2bc385a03`.

<a id="contract-40"></a>

## Contract: #40 Review schema and rubric versioning - v1

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

## Contract changes

| Date | Contract | From | To | Consumers notified |
|---|---|---|---|---|
| 2026-11-16 | #40 review schema | none | v1 | #26, #27, #35, #36, #38, #39, #42, #45, #13, #46 |
