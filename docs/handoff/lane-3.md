# Lane 3 handoff

Implementation prepared locally on 2026-11-18 against `776dd9ad1571687af9cd55564b588e277c4c2b3c`. No commits or GitHub issue state changes were made.

## Current direction: local-first authoring

The user's subsequent preference supersedes the automatic quick-review and score-refresh behavior described in the original delivery below. Typing uses local rules and a Target/Action/Scope/Done checklist; advice settles after `feedbackPauseMs` (default 300 ms). Existing `quickReviewOnPause` values are ignored. Activation does not probe or warn about the model CLI. **Enhance** explicitly runs deep review and a separate rewrite; applying the result remains a separate user action. Send never starts a model review. With the optional gate enabled, local warnings can ask for confirmation; an absent score does not.

The shared quick-scoring/refresh APIs and historical latency data remain available for experiments, but are not on the active typing or send paths. The earlier policy table and automatic-review delivery notes below are historical where they conflict with this section.

## Delivery status

| Issue | Local result |
|---|---|
| #44 | Pure shared `GatePolicy`, opt-in setting, freshness checks, hard eight-second refresh deadline and policy tests |
| #23 | Secrets remain advisory warnings; feedback continues; existing privacy redaction contracts are unchanged |
| #24 | Extension rules have no trivial/skip mode; hook legacy behavior remains separate |
| #26 | Numeric schema, shared rubric, evidence rules, injection guard, edge cases, examples and full prompt snapshot |
| #21 | Shared presentation deduplication across rule notes, quick issues and questions; original highlight ranges retained |
| #45 | Append-only v2 study payload, stable linked IDs, injected recorder clock/ID generator, resumable legacy migration |
| #1 | Exact session ID on terminal launch; transcript message accounting on terminal close; input/output/cache counters separated from Preflight usage |
| #27 | Quick-only model score, current-draft display, stale/scoring/error states, first/final model observations, shared send policy |
| #11 | Stable advice until typing pauses; instant highlights; cancellation and late-result guards; no five-word/trivial exclusion |
| #6 | Paired live CLI measurements and reproducible harness; removed per-review health spawn; reuse in-flight quick checks on Send |
| #20, #4 | Pending #3's independent benchmark. GitHub #3 is open and its benchmark command/corpus has not landed. These hard dependencies were respected. |

No lane-4 `protocol.ts` or `PromptService` exists on this base. Integration uses the existing message bridge, with score messages and validated inbound input. The lane-4 owner should reconcile these seams in #43 rather than reintroduce rule scoring. `SessionService` and `FeedbackService` are exported core seams. Deep replies use `DEEP_REPLY_SCHEMA` and never produce a score; a separate rewrite button preserves the existing panel workflow without putting a rewrite inside the deep response. Lane 2 still owns context/Q&A integration.

## Gate contract

`GatePolicy.decide(ruleReport, scoreReport | null, { gateSending, threshold })` is pure. The caller is responsible for freshness. `SessionService.prepare` enforces it:

| Setting / observation | Decision |
|---|---|
| `gateSending: false`, any findings or score | Send without score/safety confirmation |
| Enabled, current score at/above threshold, no safety findings | Send |
| Enabled, current score below threshold | Confirm |
| Enabled, privacy, risk, placeholder or error finding | Confirm |
| Enabled, missing/stale score | Refresh quick review, deadline 8,000 ms |
| Refresh fails, times out, is malformed, or returns another draft/rubric | Confirm with unavailable score |

Fresh means `hashPrompt(draft)` and `RUBRIC_VERSION` match. The hash is the shared trimmed/CRLF-normalized SHA-256; there is no second hash implementation. A hard Promise deadline handles even a provider that ignores cancellation. The panel rechecks exact text after asynchronous work and confirmation. Repeated Send clicks are serialized. A concurrent quick review is reused.

`analyzeRules` returns only `RuleReport` fields, never numeric scores. Existing `analyze` remains the compatibility path for the separately installed hook and its benchmark corpus. The hook is rule-only, opt-in by installation, retains its skip/trivial behavior, and cannot read VS Code settings. `hardBlock` in extension rule reports is false; warnings still inform an explicitly enabled gate.

## Feedback and panel seams

- Host `score`: `{ type: "score", text, state: "idle" | "scoring" | "scored" | "stale" | "error", score: ScoreReport | null }`.
- Host `analysis`: original rule findings for highlights, plus `feedback` for presentation or null while waiting for a pause.
- The browser immediately invalidates displayed score on local input. It ignores late review/score messages for another text.
- Quick results use the shared numeric parser and response limits (20 issues/questions), not the stale nested schema from #26.
- Quick prompt prose changes are pinned by `core/test/__snapshots__/quickPrompt.test.ts.snap`. Rubric anchors and `RUBRIC_VERSION` remain v1; prose version is v2.
- Presentation deduplication never mutates the original rules or model results. Identical wording and common reference/success/scope gaps are displayed once. Arbitrary semantic paraphrases cannot be perfectly recognized by deterministic rules; the prompt also forbids duplicate gaps.
- No score or questions are synthesized when the model output is invalid. Valid issues survive a rejected score.

## Study schema

`study-events-v2.jsonl` uses #35's envelope `{ schemaVersion: 1, seq, id, ts }` and an independent `studySchemaVersion: 2`. Do not raise the generic repository envelope version for a payload change.

Every event has `event`, `participant`, `draftId`, `sendId`, and nullable `sessionId`. Review and score events also share `reviewId`. Before the terminal send assigns its agent session ID, the score/review event's session ID is null; join through `sendId` to the send's session. IDs originate from the composition root; `StudyRecorder` injects `Clock` and `IdGenerator` for deterministic event envelopes.

Event types:

| Event | Data |
|---|---|
| `score` | Parsed quick `ScoreReport` or null, availability, quick source, profile, latency, usage, cost, prompt hash |
| `review` | Review ID, quick/deep mode, profile, latency, usage/cost, prompt hash; no repeated draft |
| `send` | Target, prompt hash, first/final completed model scores or null, score metadata/age/availability, draft duration, confirmation, review counts, separate Preflight and nullable agent counters |
| `agent-usage` | Exact send/session link, provider, observed input/output/cache counters, observed session cost or null, availability and completion |
| `outcome` | Caller-supplied experiment result linked to the send; #7 owns outcome collection |

Common metadata fields (`provider`, `model`, `thinkingEffort`, `rubricVersion`, `scoreSource`, `latencyMs`, `contextManifestHash`, `tokens`, `cost`) default to null when unknown. `contextManifestHash` is null while the panel's deep-context integration is pending; it is never fabricated from a different context source.

The exact sent draft is stored once in `sends.jsonl`, including the shared hash and session ID. Study events reference it. Score/review observations only exist if a model review actually completed; default advisory Send never forces an otherwise unwanted model request. `firstScore` is the first completed model score in the draft, and `finalScore` matches the sent text. Neither can contain the hook's symbolic score.

Logging is opt-in; concurrent writes use #35's serialized append-only repository. Logging failure does not prevent a prompt that has already been handed off from clearing successfully. Send-history persistence failure is surfaced to the user without sending a second time.

### Migration

On the first enabled write, legacy `study-log.jsonl` lines are read and passed through #35's migration runner. Valid send lines gain deterministic `legacy-<line number>` IDs; already imported IDs are skipped after interruption/restart. Corrupt/unsupported rows are counted and ignored. The source file remains untouched. Legacy first/final symbolic scores do not become model scores: `scoreAvailable: false`, `firstScore/finalScore: null`, `legacyRuleScore` retains the old final value. Old prompt text remains only in the migrated send event.

### Agent accounting

Each terminal launch uses an explicit `--session-id` and runs the Claude executable directly with argument arrays (paths with spaces are supported). When the process exits/closes, the reader selects only that exact workspace/session. It streams transcript rows and retains only usage metadata. Assistant snapshots sharing `message.id` replace earlier snapshots; counters are summed once per message. Cache read/creation tokens stay separate from uncached input. `SessionSlice.tokens` is never used.

No explicit transcript cost means null, not an estimate based on model pricing. Clipboard sends have no automatic agent session association. A missing/unreadable session produces an unavailable observation rather than guessing from recency. Persistent recovery now resumes pending collection after restart; see the follow-up below. A user who continues chatting in the same terminal session will contribute those turns to that one session's usage, matching the one-prompt/one-session study assumption.

## Lane-3 follow-up: durable agent usage recovery (#1, #45)

Implemented on 2026-11-19. This follow-up stays within lane 3. Connecting Enhance to workspace artifacts, Q&A and instruction files remains with lane 2 (#46, #15, #48); those features were not changed here.

- `AgentUsageRecovery` persists a prompt-free tracking intent in `agent-usage-pending.jsonl` before terminal handoff. Jobs carry the original draft/send/session/folder IDs and participant label. A failed handoff cancels the intent.
- Activation reconstructs jobs from disk. A background retry runs every 30 seconds, including when no panel is open. Previous opt-in terminal sends are joined with the durable send records to seed missing jobs; unlogged, clipboard, cancelled and already-completed sends are excluded.
- Reads target the exact Claude project directory and session filename, using the shared project-path encoding. Invalid session IDs are rejected; no recency fallback and no LLM call exist in the recovery path.
- A terminal close persists exit evidence before reading usage. Launch metadata (`PREFLIGHT_AGENT_SESSION_ID`, with argument-array fallback) lets a restored terminal attach its close event to a known job. Both the original callback and activation listener may fire; the serialized collector handles them idempotently.
- Recovered snapshots are `complete: false` until exit is confirmed. A quiet file or an absent terminal handle is not evidence of completion. If restored terminal metadata is unavailable, usage still recovers but remains partial. Missing, malformed/empty and unreadable transcripts remain retryable, even after a known exit.
- `agent-usage` events have `observation: "cumulative-snapshot"`, `recovered`, and `complete`. Join by `sendId`, then use the latest available observation (highest sequence), preferring a confirmed complete observation; never sum snapshots. Input/output/cache counters remain separate from Preflight usage and `SessionSlice.tokens`.
- Snapshot IDs are derived from send ID and observed counters/completion state. `StudyLog.writeOnce` serializes ID checks and appends. If the host stops after the study append but before the job checkpoint, recovery reuses that event ID and finishes the checkpoint without duplicating the observation.
- The original participant label is persisted on the job. Changing the current setting does not relabel a recovered send. Logging off prevents transcript reads and study writes; exit evidence can still be checkpointed. Re-enabling logging resumes pending jobs.
- Terminal sending and local-first typing behavior are unchanged. No deep-context, Q&A, panel-protocol, benchmark, or other-lane implementation is included.

Verification: `npm run typecheck`, `npm test` (586 passed), and `npm run e2e` (13 scenarios passed; the command builds extension and hook). Recovery tests cover collector recreation from disk, growing/missing transcripts, opt-out and opt-out races, write/checkpoint failures, duplicate recovery, exact-session association, historical opt-in sends, failed handoff cancellation and participant changes. E13 runs persisted collector/log recreation inside a real VS Code extension host; it simulates losing in-memory state rather than restarting the entire VS Code application.

## Latency

Measured locally on 2026-11-18 with the authenticated Claude CLI, quick model `haiku`, effort `medium`, one fixed coding prompt, three alternating before/after pairs. The baseline is the original `QUICK_SYSTEM` from `776dd9a` plus the old per-review health probe; the new path uses the current prompt without the redundant health probe. Timings include CLI startup and model completion, not the typing pause.

| Pair | Before (ms) | After (ms) |
|---|---:|---:|
| 1 | 9252 | 5185 |
| 2 | 8054 | 6055 |
| 3 | 6337 | 5422 |
| Median | 8054 | 5422 |

About 33% lower observed median. All six responses produced valid scores. The two-second target is unmet. This small single-prompt sample does not isolate health-probe cost from prompt/model/network variation. The new guardrails increase input size; observed output-token counts decreased. No warm-process/API implementation was added without evidence. In-flight reuse avoids duplicate calls when Send arrives during a quick review; successful unchanged text also avoids repeated pause checks.

Raw metadata: [quick-latency-2026-11-18.json](../measurements/quick-latency-2026-11-18.json).

Reproduce with `npm run benchmark:quick` (six billable/account-backed CLI calls). Override `PREFLIGHT_BENCH_CLI`, `PREFLIGHT_BENCH_BASE`, or `PREFLIGHT_BENCH_OUTPUT` when needed. Output contains only timings/usage/availability, never the draft or model text. A failed call is reported but excluded from a successful-response median.

## Validation

- `npm run typecheck`
- `npm test`: 573 tests passed.
- `npm run build`
- `npm run e2e`: 12/12 scenarios passed in a real VS Code host, including terminal-exit usage accounting.
- `npm run e2e:webview`: 18/18 real Chrome checks (override `CHROME_BIN` outside macOS).
- Six real quick CLI calls supplied the latency measurements above.

The panel integration tests exercise default advisory sending, exact draft preservation, linked model observations, quiet advice until pause, malformed bridge messages, late-result rejection, in-flight reuse, and transcript usage linked by send ID. Gate tests enforce freshness, rubric invalidation, disabled gating, all safety categories, failed refresh and a provider that ignores abort.
