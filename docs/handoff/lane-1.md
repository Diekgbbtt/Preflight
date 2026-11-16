# Lane 1 handoff ledger

The ledger is the only cross-ticket memory for Lane 1.
It is authoritative for consumers in lanes 2, 3, and 4.
Every entry has a contract version and a change log.

## Status

| Ticket | State | Branch | Commit | Tests | Reviewer |
|---|---|---|---|---|---|
| #40 | merged | ticket/40-review-schema | cf5cdbbcacbb73468dc8b8c0d90eb41eb59bc622 | `npm run typecheck && npm test && npm run build` -> 111 passed | PASS |
| #41 | merged | ticket/41-privacy-policy | bf2bb83575f7007a9537c5802e5146587990fcc0 | `npm run typecheck && npm test && npm run build` -> 151 passed | PASS |

Source branch: `lane-1/control-plane`.
Setup commit: `098e887` (`chore: set up lane 1 worktrees and extension tests`).
Lane base for ticket #40: `098e8873371ef995ba7cb1a2ddbd50a2bc385a03`.
Lane base for ticket #41: `9ed943f7e352c4c56653ed5e003607a3d79d2a34`.

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

<a id="contract-41"></a>

## Contract: #41 Privacy and consent boundary - v1

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
  - The `EXCLUDE_GLOB` string is duplicated in `extension/src/workspace.ts`. #36 owns the cleanup.
  - `clearHistory` is documented but not implemented until #35.
- Change log:
  - v1: initial contract merged in #41.

## Contract changes

| Date | Contract | From | To | Consumers notified |
|---|---|---|---|---|
| 2026-11-16 | #40 review schema | none | v1 | #26, #27, #35, #36, #38, #39, #42, #45, #13, #46 |
| 2026-11-16 | #41 privacy boundary | none | v1 | #36, #38, #13, #46 |

## Dispatch notes

- The default provider balance was exhausted during lane 1.
- The free-model fallback also reached its usage limit.
- All implementer and reviewer dispatches after #40 used `opencode-go/glm-5.3-flash`.
- No task scope or acceptance criterion changed because of the model fallback.
