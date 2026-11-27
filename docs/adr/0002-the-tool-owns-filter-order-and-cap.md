# The tool owns filter, canonical order, and cap

Ticket #61: the adapter truncated the `rg` output at the caller cap in arrival order, so the tool could never recover a match the port had already truncated away, and the kept set changed between runs.
`rg --sort path` would make the walk single-threaded and slower on large trees, and it would bind the determinism promise to one adapter.
We decided that the text-search port returns the complete match list, bounded only by the per-file `--max-count` and the exec buffer, and that the tool applies `isAllowed`, sorts canonically by path, line, and character, and then caps.
The same shape applies to the `listFiles` fallback: the port returns the complete bounded file list and the tool filters, sorts alphabetically, and caps.
Sorting after parse keeps `rg` parallel and makes determinism a property of tool results rather than an accident of adapter internals, which is the established pattern for this repo.
When the bounded output exceeds the exec buffer the run fails deterministically (same tree and query produce the same output size) and degrades fail-soft to `emptyResult("error")`, as before.
