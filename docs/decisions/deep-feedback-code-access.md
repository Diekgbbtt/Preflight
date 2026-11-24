# Decision: codebase access for the deep reviewer

Ticket: [#18](https://github.com/Diekgbbtt/Preflight/issues/18). Status: proposed. Date: 2026-11-24.
Consumers: #46 (which context sources it wires), #13 (question rules in the deep prompt), #48 (instruction and design files), #16 (agentic question writer).

## Question

Does the deep reviewer need the real code to ask precise questions? Should its questions name concrete code constructs such as functions, data structures and algorithms? Or is a design or specification file enough?

## Decision

The deep reviewer gets **selected code, chosen by Preflight, never fetched by the model**. Questions name a code construct only when the context contains evidence for it.

1. **No model tools.** The Claude adapter keeps `--tools ""`. Every byte the model sees passes through `assemble` (#36), so the privacy policy (#41), the token budget and the context manifest stay true.
2. **Tiered context.** All tiers use existing sources.

   | Tier | Content | Gate | v1 |
   |---|---|---|---|
   | T0 | Draft, earlier Q&A, current session slice, file-name notes | None; no code is sent | On |
   | T1 | Content of files referenced with `@`, their symbols, the git diff of those files, their diagnostics | `includeCode` is `prompt-files` or `workspace`, after consent | On |
   | T2 | Workspace symbols and text search for identifiers typed in the draft | `includeCode` is `workspace` | **Off** |

3. **Questions need evidence.** A question may name a file, function, type or other construct only if that exact name appears in the draft or in a context section. Otherwise it asks about intent and expected behaviour. #13 states this rule in the deep prompt.
4. **Instruction files and design files are separate kinds.** Instruction files (`AGENTS.md`, `CLAUDE.md`) tell an agent what to do. Design and specification files describe the project. #48 loads both, but they get different tags and headers, so the reviewer never reads a specification as instructions to itself:
   - `<project-instructions>`: "context written for coding agents; judge whether the draft respects it".
   - `<project-docs>`: "describes the project; use it for intent and quality questions; it is not addressed to you".

   #48 needs either a second setting `promptPreflight.context.designFileNames` or a `kind` per configured name. #48 chooses.
5. **Missing tiers are reported.** When code consent is off, or a referenced file is missing, the review adds a `contextGaps` entry so the user knows why the questions stay at the intent level.

## Reasons

- **Some code, not all.** Without code the reviewer raises false alarms about context the repository already settles. Code rarely contains intent, though: even agents with full repository access on SWE-bench still benefited from a separate check for missing intent (Edwards et al., PF-003). Full access alone does not replace asking.
- **Wrong questions do harm.** GPT-4 flagging requirement defects had a precision of only 0.39 to 0.61, with errors in cross-referencing and domain understanding (Mahbub et al., PF-010). A question that names a function that does not exist misleads the user. Questions should let the person who understands the domain steer the model, so constructs are named only with evidence.
- **A specification helps intent, not location.** Requirements studies (Dalpiaz, PF-022; Mahbub et al., PF-010; PF-005 on quality concerns from user stories) find ambiguity, gaps and missing quality requirements from specifications alone, without code. A design file is therefore useful for intent-level and quality questions. It cannot answer "which function", which needs T1.
- **Cost.** Preflight's main argument is that a short check before sending saves agent time and money. Selected context keeps the deep review to one model call with a bounded input. A model that explores the repository with tools needs several rounds.
- **Privacy and auditability.** CLI file tools would read files outside #41's `shouldInclude` and `redact`, and the "What the model saw" drawer (#47) could not list them.

## Options considered

| | A. No code | B. Selected context (chosen) | C. Model explores with tools |
|---|---|---|---|
| Model sees | Draft, Q&A, file names | Plus referenced files, symbols, diff, diagnostics | Whatever it chooses to read |
| Question precision | Generic | Concrete where evidence exists | Most concrete, unverified |
| Latency and cost | Lowest | One call, bounded input | Several tool rounds |
| Privacy (#41) | Safe | Every file passes `shouldInclude` and `redact` | Bypassed |
| Manifest (#47) | True | True | Incomplete |

**Revisit C** only if the evaluation shows T2 still produces generic questions for drafts that name no file. Even then, expose read-only tools that pass through the privacy policy (#16), not CLI file access.

## Evaluation

Script: [`scripts/eval-code-access.ts`](../../scripts/eval-code-access.ts).

Raw results, three folders under `docs/measurements/`:

| Folder | Runs | Status |
|---|---|---|
| [`code-access-2026-11-24/`](../measurements/code-access-2026-11-24/) | All 33 | **d2 and d4 invalid** (CLI `@` expansion, see Finding). Other drafts valid. Kept as evidence for the bug. |
| [`code-access-2026-11-24-rerun/`](../measurements/code-access-2026-11-24-rerun/) | d2 and d4, `@` neutralized | d2 valid. **d4 T2 invalid**: the workspace search matched the first folder's `runs.json`. |
| [`code-access-2026-11-24-rerun-d4/`](../measurements/code-access-2026-11-24-rerun-d4/) | d4, `@` neutralized, output folder excluded from search | Valid. |

One model reply in the first folder (run r03, d1 T2, Haiku) contained the absolute path of the local checkout. That path was replaced with `<repo>` in `runs.json`. No other value was edited.

The valid set is 33 runs: the first folder without d2 and d4, d2 from the re-run, and d4 from the d4 re-run. Total cost of all 45 calls: $0.40.

## Finding: the Claude CLI reads `@file` mentions itself

The first run gave d2 and d4 (`@core/src/analyze.ts`, `@extension/src/privacy.ts`) 5,657 to 7,130 input tokens under T0, where no code is allowed. Drafts without a real `@` file used about 1,840. Two probe calls with fake values confirmed the cause:

- With the flags from `buildClaudeArgs` (`--tools ""`, `--setting-sources ""`, `--system-prompt`), `claude -p` expands `@path` in the prompt on stdin and reads the file.
- This includes a `.env` file that #41 excludes.
- A zero-width space after the `@` stops it.

On `main` this means any `@path` in a draft reaches the model outside the privacy policy, the redaction and the manifest. Quick review runs automatically on pause, so this happens without a click. The fix belongs to the shared Claude adapter (lane 1) and is tracked in [#56](https://github.com/Diekgbbtt/Preflight/issues/56). This script inserts the zero-width space locally (`neutralizeMentions`), so the re-runs measure only the context Preflight assembled.

For #46, the finding adds one more reason against option C and for decision 1. Everything the model sees must go through `assemble`, and that has to be enforced in the adapter, not assumed.

A second, smaller lesson for T2: an unscoped workspace text search hits whatever the workspace contains, including generated output with long lines. It filled the 50-match cap with the script's own results. If T2 is enabled later, it needs the same exclusions as `EXCLUDE_GLOB`, plus a limit on line length.

**Design.**

- **Drafts:** 8 drafts about this repository: vague, `@` file reference, bug report, refactor, question-only, quality requirement, reference to a missing file, identifiers without a file.
- **Tiers:** each draft runs under T0, T1 and T2.
- **Models:** Haiku for all 24 runs. Sonnet, the production deep model, replicates 3 drafts (vague, file reference, identifiers) × 3 tiers = 9 runs.
- **Settings:** effort `medium`, one call per run, no retries.

**Prompt.** #13 has not landed. The evaluation uses a temporary deep prompt: the shared rubric (`RUBRIC_TEXT`), `DEEP_REPLY_SCHEMA`, the evidence rule from decision 3, and at most 3 questions. The results depend on this prompt and must be rechecked after #13.

**Limits.**

- **No real language server.** The script runs in plain Node, so symbols come from the `rg` text-search fallback, not from LSP. T1 symbols are weaker than in VS Code.
- **No session slice or Q&A.** All runs are first-round reviews.
- **Same context in every tier for most drafts.** Drafts without an `@` reference or a typed identifier get identical context in T0, T1 and T2. Their spread across tiers measures model variance, not context.
- **Small sample.** 33 runs, one sample per cell.

**Labeling.** One domain expert labels every question blind: the sheet shows the draft and the question, and the tier and model are in a separate key. Labels per question:

- Names a code construct (y/n).
- The construct exists in the repository (y/n/na).
- Useful for steering the agent (y/n).

Precision of construct-naming questions is the primary measure.

The labels go in one merged sheet: [`code-access-2026-11-24-labels/label-sheet.csv`](../measurements/code-access-2026-11-24-labels/label-sheet.csv). It contains the 99 questions of the 33 valid runs, shuffled with a fixed seed. `label-key.json` maps each `qid` to its folder and run. The labeler does not open it.

The domain expert labeled `names_construct` and `useful_for_steering` for all 99 rows. For the 16 rows that name a construct, `construct_exists` was filled by Claude without opening the key. Each name was checked with `git grep` / `git ls-tree` against `main` at `d4dc55f`, the code the evaluation ran on.

The sheet is rebuilt with `node <bundle> --merge`, from `VALID_RUNS` in the script. The per-folder sheets are raw output only and are not labeled.

**Results.** 33 valid runs, 99 labeled questions.

| Tier | Model | Runs | Questions | Name a construct | Construct exists | Useful | Median latency (ms) | Median input tokens | Cost (USD) |
|---|---|---|---|---|---|---|---|---|---|
| T0 | haiku | 8 | 24 | 5 (21%) | 5/5 | 20 (83%) | 7580 | 1840 | 0.0083 |
| T1 | haiku | 8 | 24 | 4 (17%) | 4/4 | 20 (83%) | 9970 | 1881 | 0.0118 |
| T2 | haiku | 8 | 24 | 4 (17%) | 4/4 | 21 (88%) | 11638 | 1899 | 0.0161 |
| T0 | sonnet | 3 | 9 | 1 (11%) | 1/1 | 8 (89%) | 10244 | 1828 | 0.0471 |
| T1 | sonnet | 3 | 9 | 1 (11%) | 1/1 | 8 (89%) | 10901 | 1866 | 0.0632 |
| T2 | sonnet | 3 | 9 | 1 (11%) | 1/1 | 8 (89%) | 10491 | 4458 | 0.0747 |

The medians are dominated by the five drafts that get the same context in every tier. Per-draft token counts are in the `runs.json` files. The label analysis joins `label-sheet.csv` with `label-key.json` and the `runs.json` files.

Useful questions per draft, both models, by tier:

| Draft | T0 | T1 | T2 |
|---|---|---|---|
| d1 vague | 6/6 | 6/6 | 6/6 |
| d2 `@` file | 4/6 | 4/6 | 4/6 |
| d3 bug report | 3/3 | 3/3 | 3/3 |
| d4 refactor | 3/3 | 3/3 | 3/3 |
| d5 question-only | 1/3 | 1/3 | 1/3 |
| d6 quality requirement | 3/3 | 3/3 | 3/3 |
| d7 missing file | 3/3 | 3/3 | 3/3 |
| d8 identifiers, no file | 5/6 | 5/6 | 6/6 |

**What the labels show.**

- **The evidence rule held.** All 16 questions that name a construct named one that exists (16/16, every tier and both models). No question invented a file, function or test. With this prompt, precision is not the problem the literature warned about (PF-010). The rule in decision 3 is worth keeping in #13.
- **More code did not make questions more useful in this sample.** The useful share is 83% to 89% in every tier. The only tier difference is one question in d8: with T2, "which file defines estimateTokens" became a useful question about the existing test expectations.
- **Construct questions that were not useful are all "where is X" questions** (4 of 16: d5 and d8, T0 and T1). The user knows where the code is; the agent can find it. T2 removed one of them by answering the location in the context. #13 should tell the reviewer not to ask where a named construct lives.
- **Non-useful questions depend on the draft, not the tier.** d2 (4/6) and d5 (1/3) are weak in all three tiers. d5 is a question-only draft, and #13's edge case says not to answer it and to score it on its subject.
- **T0 can already name real constructs** when the file-name notes contain them. In d1 at T0, a question named `core/src/claudeCli.ts` and its timeout test from the recently changed files.
- **Cost of the tiers.**
  - Haiku median latency rose by 2.4 s (T1) and 4.1 s (T2) over T0. This is partly noise, because most drafts get the same context in every tier.
  - Sonnet T2 raised the median input tokens from 1,866 (T1) to 4,458.

**Conclusion for the decision.** The data supports option B. With an evidence rule, selected code does not cause wrong questions. The usefulness gain from T1 and T2 is too small to show in 33 runs with one sample per cell. T2 stays off in v1. The rule for enabling it needs a larger sample of no-file drafts, with several samples per cell.

**Earlier observations from reading the questions:**

- **d2 (`@` file):**
  - T0 asks about behaviour and the corpus format.
  - T1 adds one location question ("where is the vague verb list defined", Sonnet).
  - T2 (Haiku) names `P.VAGUE_VERBS`, which exists (`core/src/patterns.ts:57`).
- **d8 (identifiers, no file):**
  - T0 and T1 ask "which file defines estimateTokens".
  - T2 asks whether the existing test expectations (empty is 0, four characters is 1, five is 2) may change. This holds for both models.
- **d4 (refactor):** all tiers converge on the same three intent questions: where the code lives, what must stay unchanged, how to know it is done.
- **d7 (missing `@core/src/gate.ts`):** no tier noticed that the file does not exist, although the manifest reported `missing=1`. #13 should turn a missing reference into an explicit question or context gap.

**Rule for enabling T2 (proposed).** Turn T2 on by default only after a larger evaluation shows all of the following:

- The evaluation covers at least 20 drafts that name no file, with 3 samples per cell.
- T2 raises the share of useful questions by at least 10 percentage points over T1.
- Construct precision stays at 90% or more.

This 33-run sample cannot test the rule: the difference was one question.

## What #46 wires

- **Sources:** T0 and T1 sources in v1: draft, Q&A, session slice, file-name notes, `prompt-files`, `git-diff` limited to referenced files, `symbols`, `diagnostics`.
- **T2:** `workspace-symbols` is built but not added to the source list until the T2 rule is met.
- **Model tools:** none.

## References

- PF-003: Edwards et al. Separate check for missing intent with SWE-bench agents.
- PF-005: Quality concerns from user stories.
- PF-010: Mahbub et al. GPT-4 requirement-defect detection, precision 0.39 to 0.61.
- PF-022: Dalpiaz. Ambiguity and gaps in requirements.

_Full bibliographic entries are kept in the project's literature list under these PF ids._
