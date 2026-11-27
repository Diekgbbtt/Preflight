# Prompt Preflight

Preflight gives feedback on coding-agent prompts before they are sent.
This is the glossary for the whole repository.
The vocabulary below is used verbatim in code, tests, docs, and tickets.

## Language

### Rules and review

**Rule pre-check**:
The free, instant tier 1 score that `analyze()` computes from the four dimensions.
_Avoid_: pre-score, rule score

**Quick review**:
The one model call after a typing pause; the only producer of a model score.
_Avoid_: fast review, tier 2 score

**Deep review**:
The on-request review that never scores and returns issues, questions, assumptions, and context gaps.
_Avoid_: deep analysis

**Improved prompt**:
The separate rewrite action that leaves unknown details as `[placeholders]`.
_Avoid_: rewrite, fixed prompt

### Context and privacy

**Include policy**:
The `IncludePolicy` record that decides which code may enter a model call: the effective `includeCode` value plus the explicitly referenced prompt files.
_Avoid_: privacy settings, filter config

**prompt-files**:
The include mode in which only files the draft referenced with `@` may be sent.
_Avoid_: active-file (legacy value that reads as prompt-files)

**Excluded file**:
A file the exclusion list or the workspace boundary rejects; an excluded file is never opened.
_Avoid_: forbidden file, blocked file

**Policy-hidden result**:
A result the include policy rejected at the code-tools seam; a policy-hidden result never falls back.
_Avoid_: filtered-out result, dropped result (reserved for the count)

**Redaction**:
The replacement of every secret match with `[redacted]` before text leaves the machine.
_Avoid_: masking, sanitization

### Code tools

**Code tools**:
The read-only agent tool layer (`createCodeTools`) over LSP types with a text-search fallback.
_Avoid_: codebase tools (reserved for the exported interface name `CodebaseTools`), agent API

**Code-tools seam**:
The seam where the pure tool layer enforces policy, caps, timeouts, cancellation, and fallback decisions, reached through ports only.
_Avoid_: tool boundary, adapter seam

**Language protocol**:
The `LanguageProtocol` port the VS Code adapter implements for the LSP-backed tools.
_Avoid_: LSP wrapper, language API

**Text-search port**:
The `TextSearchPort` the adapter binds to the bundled `rg`; it receives a plain search scope and returns matches.
_Avoid_: rg wrapper, search API

**Allowed path set**:
The workspace-relative paths the include policy permits the search to open; under `prompt-files` this is exactly the referenced prompt files, and an empty set means nothing may be searched.
_Avoid_: whitelist, allowed files

**Text-search fallback**:
The switch to text search when an LSP-backed tool returns no data and a query exists; every fallback site routes through one shared path.
_Avoid_: rg fallback (per-tool wording)

**Never-open rule**:
The rule from ticket #36 that an excluded file is never opened; policy-scoped search extends it to the search itself.
_Avoid_: never-read rule

### Result envelope

**Fail-soft result**:
A tool result that reports its outcome instead of throwing, via `emptyResult(reason, dropped)`.
_Avoid_: safe result, degraded result

**Empty result**:
A fail-soft result with no items and an `omittedReason` of `empty`, `excluded`, `unsupported`, or `error`.
_Avoid_: null result, zero result

**Omit reason**:
The `omittedReason` discriminant stating why a tool returned no items.
_Avoid_: error reason, empty reason

**Dropped count**:
The number of items the port or provider returned that the policy rejected.
_Avoid_: filtered count, hidden count

**Truncated flag**:
The flag that is true when allowed items exist beyond the cap.
_Avoid_: clipped flag, cut flag

**Caps**:
The per-tool item ceilings in `CODE_TOOL_CAPS`.
_Avoid_: limits, budgets

**Provenance**:
The facts kept with a result or fragment: source id, fallback kind, dropped and truncated counts.
_Avoid_: metadata, origin

**Canonical order**:
The deterministic (path, line, character) order tool results are sorted into before capping.
_Avoid_: sorted order, natural order

**Fallback kind**:
The discriminant `text-search` marking a result that switched to text search.
_Avoid_: fallback marker, fallback flag
