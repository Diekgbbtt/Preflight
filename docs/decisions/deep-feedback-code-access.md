# Decision: codebase access for the deep reviewer

Ticket: [#18](https://github.com/Diekgbbtt/Preflight/issues/18). Status: proposed. Date: 2026-11-24. Revised the same day with the clean re-run.
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

   #48 (#60) uses a second, opt-in setting `promptPreflight.context.designFileNames` for design files.
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

There were two rounds:

- **Pilot (first evaluation):** a temporary prompt, run in the live checkout. It found two bugs and has three limits (see below).
- **Main result (clean re-run):** the temporary prompt and the real `deep-v2` prompt (#13), both run on a clean worktree of `d4dc55f`, so only the prompt differs. A follow-up run adds the instruction files (#48) to one draft.

The conclusions below come from the main result.

Raw results, all under `docs/measurements/`:

| Folder | Round | Runs | Status |
|---|---|---|---|
| [`code-access-2026-11-24/`](../measurements/code-access-2026-11-24/) | Pilot | All 33 | **d2 and d4 invalid** (CLI `@` expansion, see Findings). Kept as evidence for #56. |
| [`code-access-2026-11-24-rerun/`](../measurements/code-access-2026-11-24-rerun/) | Pilot | d2 and d4, `@` neutralized | d2 used. d4 T2 not used. |
| [`code-access-2026-11-24-rerun-d4/`](../measurements/code-access-2026-11-24-rerun-d4/) | Pilot | d4, `@` neutralized | Used, with the text-search limit below. |
| [`code-access-2026-11-24-labels/`](../measurements/code-access-2026-11-24-labels/) | Pilot | 99 labeled questions | Question-text labeling rule (see below). |
| [`code-access-2026-11-24-temp-clean/`](../measurements/code-access-2026-11-24-temp-clean/) | Main | All 33, temporary prompt | Clean worktree of `d4dc55f`. |
| [`code-access-2026-11-24-deep-v2/`](../measurements/code-access-2026-11-24-deep-v2/) | Main | All 33, `deep-v2` | Clean worktree of `d4dc55f`. |
| [`code-access-2026-11-24-clean-labels/`](../measurements/code-access-2026-11-24-clean-labels/) | Main | 173 labeled questions | Both main folders in one blind sheet. |
| [`code-access-2026-11-24-deep-v2-instructions/`](../measurements/code-access-2026-11-24-deep-v2-instructions/) | Follow-up | d2, `deep-v2` with `CLAUDE.md` | Clean worktree. Not labeled; measured automatically. |

**Local paths:** in the pilot folder, one model reply (run r03, d1 T2, Haiku) contained the absolute path of the local checkout. It was replaced with `<repo>`. In the follow-up folder, the worktree path in `instructionFiles[].folder` was replaced with `<worktree-of-d4dc55f>`. Absolute `--out` paths in the label keys were made relative. No other value was edited.

**Cost:** 117 calls in total, $0.96 (pilot $0.40, main $0.45, follow-up $0.11).

### Design

- **Drafts:** 8 drafts about this repository:
  - d1: vague;
  - d2: `@` file reference;
  - d3: bug report;
  - d4: refactor;
  - d5: question only;
  - d6: quality requirement;
  - d7: reference to a missing file;
  - d8: identifiers without a file.
- **Tiers:** each draft runs under T0, T1 and T2.
- **Models:** Haiku for all 24 draft-and-tier combinations. Sonnet, the production deep model, repeats d1, d2 and d8 × 3 tiers = 9 runs. That makes 33 runs per prompt.
- **Settings:** effort `medium`, one call per run, no retries. `@` is neutralized in every main run.
- **Prompts in the main round:**
  - `eval-temporary`: the rubric, `DEEP_REPLY_SCHEMA`, the evidence rule from decision 3, and at most 3 questions;
  - `deep-v2`: the #13 prompt (`buildDeepPrompt`).
- **Context in the main round:** built from a git worktree of `d4dc55f` (`PREFLIGHT_EVAL_RG` points at the bundled `rg`). The pilot's own script and documents were therefore not in the workspace. 29 of 33 run pairs have identical manifests; the 4 others differ because of the text-search behaviour in #61 (see Findings).

### Labeling

One domain expert labels every question blind. The sheet shows the draft, the question, the reason and the options. Prompt, tier and model are in a separate key that the labeler does not open.

- **Names a code construct (y/n):** the question **or one of its options** names something that can be looked up exactly (a file, function, constant, type or test).
- **The construct exists (y/n/na):** checked by Claude with `git grep` / `git ls-tree` against `d4dc55f`, without opening the key.
- **Useful for steering the agent (y/n):** judged by the expert from the draft and domain knowledge.

Construct precision (the share of named constructs that exist) is the primary measure.

### Main result: temporary prompt vs `deep-v2`, same context

| Prompt | Model | Tier | Questions | Name a construct | Construct exists | Useful |
|---|---|---|---|---|---|---|
| temporary | haiku | T0 | 24 | 8 (33%) | 8/8 | 22 (92%) |
| temporary | haiku | T1 | 24 | 7 (29%) | 7/7 | 19 (79%) |
| temporary | haiku | T2 | 24 | 6 (25%) | 5/6 | 21 (88%) |
| temporary | sonnet | T0 | 9 | 1 (11%) | 1/1 | 8 (89%) |
| temporary | sonnet | T1 | 9 | 2 (22%) | 2/2 | 9 (100%) |
| temporary | sonnet | T2 | 9 | 2 (22%) | 2/2 | 8 (89%) |
| deep-v2 | haiku | T0 | 18 | 5 (28%) | 5/5 | 17 (94%) |
| deep-v2 | haiku | T1 | 18 | 5 (28%) | 5/5 | 16 (89%) |
| deep-v2 | haiku | T2 | 20 | 7 (35%) | 7/7 | 17 (85%) |
| deep-v2 | sonnet | T0 | 6 | 1 (17%) | 1/1 | 5 (83%) |
| deep-v2 | sonnet | T1 | 6 | 0 (0%) | – | 5 (83%) |
| deep-v2 | sonnet | T2 | 6 | 1 (17%) | 1/1 | 5 (83%) |

| Totals (33 runs each) | temporary | deep-v2 |
|---|---|---|
| Questions | 99 | 74 |
| Useful | 87 (88%) | 65 (88%) |
| Construct exists | 25/26 | 19/19 |
| Issues | 120 | 77 |
| Context gaps | 121 | 62 |
| Median latency, Haiku T0 / T1 / T2 (s) | 8.6 / 8.6 / 10.5 | 7.4 / 5.5 / 5.5 |
| Median input tokens, Haiku T0 | 2,202 | 3,429 |
| Cost | $0.241 | $0.210 |

Useful questions per draft, both models and all tiers:

| Draft | temporary | deep-v2 |
|---|---|---|
| d1 vague | 18/18 | 14/14 |
| d2 `@` file | 15/18 | 8/14 |
| d3 bug report | 9/9 | 7/7 |
| d4 refactor | 9/9 | 7/7 |
| d5 question only | 4/9 | 6/7 |
| d6 quality requirement | 7/9 | 5/6 |
| d7 missing file | 8/9 | 7/7 |
| d8 identifiers, no file | 17/18 | 11/12 |

**What the main result shows:**

- **Precision holds with both prompts.** Every construct named with `deep-v2` exists (19/19). The only invented construct in the main round, `core/src/gate.ts` (temporary prompt, d7 T2), does not appear with `deep-v2`. With an evidence rule, precision is not the problem the literature warned about (PF-010).
- **`deep-v2` keeps the useful share (88%) with 25% fewer questions.** The temporary prompt always filled the limit (3 questions in every run). `deep-v2` drops questions instead, and is faster and cheaper despite the longer prompt, because the replies are shorter.
- **The question-only rule works:** d5 improves from 4/9 to 6/7 useful.
- **d2 gets worse, and the cause is missing project knowledge, not the prompt.** 6 of the 8 not-useful d2 questions with `deep-v2` ask where the corpus is. This repository's `CLAUDE.md` answers that, but no instruction files were loaded in the main round. The follow-up below tests this.
- **More code still brings no measurable gain.** With both prompts, the useful share is about the same in T0, T1 and T2, also for drafts that name no file (temporary 90/81/90%, `deep-v2` 100/93/88%).
- **Construct questions that are not useful** are mostly "where is X" or "which code path" questions (9 of 45, in d5, d6 and d8).

### Follow-up: d2 with instruction files

The same d2 runs (3 tiers × 2 models) with `deep-v2` plus the #48 instruction block. The loader found the root `CLAUDE.md` (256 tokens, not truncated). This was measured automatically, without labels.

| | Without instructions | With `CLAUDE.md` |
|---|---|---|
| Questions | 14 | 7 |
| "Where is the corpus" questions | 6 | **0** |
| Issues | 14 | 9 |
| Cost | $0.091 | $0.106 |

Instead of asking where the corpus is, 5 issues now cite the project rule: for example, "CLAUDE.md requires corpus lines for both flagged and passing prompts". This supports decision 4: instruction files close questions that code alone cannot.

One issue (Haiku T0) claims the agent cannot confirm that `core/src/analyze.ts` holds the rule, because the file list does not show it. At T0 the file list has only top-level entries, so this is a false alarm caused by the missing T1 context.

### Pilot: first evaluation (temporary prompt, live checkout)

The pilot used the same design with the temporary prompt only, run in the live checkout. Its labels (99 questions, [`code-access-2026-11-24-labels/`](../measurements/code-access-2026-11-24-labels/)) showed 16/16 existing constructs and 83% to 89% useful questions in every tier. It led to the same conclusion. It has three limits, so it is kept only as a pilot:

1. **CLI `@` expansion:** d2 and d4 were invalid in the first run (#56) and had to be re-run with `@` neutralized.
2. **Context not fully controlled:** the pilot ran in the live checkout, where the evaluation's own script and documents (and, after the first run, its `runs.json`) were part of the workspace that the text search covered. Together with the text-search behaviour in #61, this changed the T1 and T2 context of d4 and d8. In the d4 re-run, the T1 symbols of `privacy.ts` were 0 tokens instead of 63.
3. **Different labeling rule:** the pilot counted a construct only when the **question text** named it. 11 pilot rows name constructs only in their options and are labeled `n`. So the pilot's construct counts are not comparable with the main round's.

## Findings

### The Claude CLI reads `@file` mentions itself (#56)

The pilot gave d2 and d4 (`@core/src/analyze.ts`, `@extension/src/privacy.ts`) 5,657 to 7,130 input tokens under T0, where no code is allowed. Drafts without a real `@` file used about 1,840. Two probe calls with fake values confirmed the cause:

- With the flags from `buildClaudeArgs` (`--tools ""`, `--setting-sources ""`, `--system-prompt`), `claude -p` expands `@path` in the prompt on stdin and reads the file.
- This includes a `.env` file that #41 excludes.
- A zero-width space after the `@` stops it.

On `main` this means any `@path` in a draft reaches the model outside the privacy policy, the redaction and the manifest. Quick review runs automatically on pause, so this happens without a click. The fix belongs to the shared Claude adapter (lane 1) and is tracked in [#56](https://github.com/Diekgbbtt/Preflight/issues/56).

The script inserts the zero-width space locally (`neutralizeMentions`). `buildDeepPrompt` (#58) does the same for the deep path. For #46, this adds one more reason against option C and for decision 1: everything the model sees must go through `assemble`, and the adapter has to enforce that.

The working directory also reaches the model. Replies quoted the checkout path, and input tokens were about 360 higher in the worktree than in the live checkout, although the manifests differ only by 2 tokens of file-name notes. #56 tracks this too.

### The text-search fallback is not deterministic (#61)

`searchText` caps at 50 matches before it applies the privacy filter. The `rg` adapter keeps the first 50 matches in output order, and `rg` searches files in parallel. In the main round, identical inputs produced different T1 and T2 context in 4 of 33 run pairs. d4 T1 got 63 tokens of `privacy.ts` symbols once and 0 tokens once. Tracked in [#61](https://github.com/Diekgbbtt/Preflight/issues/61).

The deep path in #58 does not reach this fallback today. If T2 is enabled later, #61 must be fixed first.

## Conclusion for the decision

The data supports option B, with both prompts:

- With an evidence rule, selected code does not cause wrong questions.
- The usefulness gain from T1 and T2 is too small to show in 33 runs with one sample per cell. T2 stays off in v1.
- Project instruction files (decision 4) close a class of questions that code alone cannot. In the follow-up, they removed all "where is the corpus" questions.

**Rule for enabling T2.** Turn T2 on by default only after a larger evaluation shows all of the following:

- The evaluation covers at least 20 drafts that name no file, with 3 samples per cell.
- T2 raises the share of useful questions by at least 10 percentage points over T1.
- Construct precision stays at 90% or more.
- #61 is fixed, so the T2 context is deterministic.

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
