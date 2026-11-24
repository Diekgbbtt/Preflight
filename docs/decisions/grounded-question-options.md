# Decision: grounded options for lookup questions

Ticket: [#16](https://github.com/Diekgbbtt/Preflight/issues/16). Status: proposed, step 1 only. Date: 2026-11-24.
Builds on: the #18 evaluation ([`deep-feedback-code-access.md`](deep-feedback-code-access.md), #62).

## Question

#16 has only a title: "Agentic tool for writing question:[options] list". Lane 2 reads it as **A**: a question writer whose options are real candidates from the code, rather than generic guesses. The reading is not yet confirmed by the ticket author ([comment on #16](https://github.com/Diekgbbtt/Preflight/issues/16#issuecomment-7143802374)).

Before building an agent, step 1 tests the core idea without one: if Preflight replaces the options of a lookup question with real candidates from the code, are the questions easier to answer correctly?

## Decision

1. **No agent loop for now.** The data does not justify a tool-using question writer (step 2).
2. **Grounded options only as an addition, and only for lookup questions that remain.** Lookup questions ask where existing code is, such as "Where is the assemble function?". When such a question remains after the deep review, Preflight may offer up to 3 candidate paths:
   - from the file list (names only, no code content, so no consent needed);
   - from a definition search, which reads code locally but sends only paths, so it is allowed only when `includeCode` is not `off`.
3. **The better fix is not to ask.** Most lookup questions disappear when the context already contains the answer. With `CLAUDE.md` loaded (#48), all "where is the corpus" questions disappeared (#62). Grounded options are the fallback for the rest.
4. **Reading A waits for the ticket author.** If #16 means B or C, this decision does not apply.

## Evaluation

Script: [`scripts/eval-grounded-options.ts`](../../scripts/eval-grounded-options.ts). No model calls. Data: [`docs/measurements/grounded-options-2026-11-24/`](../measurements/grounded-options-2026-11-24/).

**Input.** The 74 `deep-v2` questions of the #18 clean re-run (`code-access-2026-11-24-deep-v2/runs.json`), at commit `d4dc55f`.

**Lookup rule** (`isLookupQuestion`). A question counts when:

- it asks where existing code is ("where is …", "which file …", "which part of the code …");
- it does not start with "where should" (a design decision);
- it does not ask where the user sees something ("appear", "show");
- it is not a compound question (contains "and"), because grounded options would drop its second part.

7 of 74 questions match, covering 3 distinct questions: the corpus (5 times), `assemble`, and the deep review.

**Grounding** (`rankCandidates`). Up to 3 paths, in this order:

1. files that define an identifier from the question (`git grep` for `function|const|class|interface|type|let <term>`);
2. files whose name is a term;
3. files whose name contains a term (source before tests before other files, shorter paths first).

**Labels.**

- **`better(1/2/same)`:** one domain expert compared the original and the grounded option set for each question. The sides were shuffled, and the key was not opened.
- **`right_in_1` / `right_in_2`:** Claude checked whether each set contains the correct location at `d4dc55f`:
  - corpus: `core/test/corpus.jsonl`;
  - `assemble`: `core/src/context.ts`;
  - deep review: `core/src/review.ts`, `extension/src/panel.ts` or `core/src/claudeCli.ts`.

### Results

| | Rows | Grounded better | Original better | Same |
|---|---|---|---|---|
| Original had options | 3 | 2 | 1 | 0 |
| Original had no options | 4 | 4 | 0 | 0 |
| **Total** | **7** | **6** | **1** | **0** |

| Correct location in the set | Grounded | Original |
|---|---|---|
| Rows | **7 / 7** | 1 / 7 |

- **The grounded candidates are correct.** In every row, the grounded set contains the right location. The original options did so once.
- **Grounding also corrects wrong options.** For `assemble`, the original option was `core/src/index.ts`, which only re-exports it; the grounded option was `core/src/context.ts`, where it is defined.
- **The informative comparison is small.** 4 of the 6 wins are against a question with no options at all. Against real original options, the grounded set won 2 to 1. In the one loss (the corpus question), the grounded list led with the right file, but its other two candidates were not corpus files (`corpus.test.ts`, `review-corpus.jsonl`).

### Limits

- **Tiny sample:** 7 pairs, 3 distinct questions, 5 of them the same corpus question.
- **Weak blinding:** grounded options are bare file paths and original options are prose or empty, so the two sides are easy to tell apart.
- **Simple rule:** keyword matching, not semantic understanding. Distractors such as test files fill slots when only one real candidate exists.
- **Offline only:** the grounded options were not shown to a model or used in a real round.

## What to build, if reading A is confirmed

- A pure core function that takes a remaining lookup question and the workspace file list and returns up to 3 candidate paths.
- Use it in the deep path after parsing, only for questions that `isLookupQuestion` accepts.
- Keep the user's free-text answer.
- List the candidates in the manifest as code-generated, so "What the model saw" (#47) stays true.
- No new model calls, no tool loop.

Revisit step 2 (a tool-using question writer) only if a larger evaluation shows that grounded candidates still miss for questions that the context cannot close. Fix #61 first, because a tool loop would depend on the text-search fallback.
