# Text search searches only policy-allowed paths

Ticket #61: the text-search fallback asks the port for at most 50 matches and applies the privacy filter afterwards, so under `prompt-files` the first 50 disallowed matches crowd out every match from a referenced file.
Ticket #36 established the rule that an excluded file is never opened.
We decided that the code-tools seam computes the allowed path set from the policy and passes it to the text-search port as a plain search scope.
Under `prompt-files`, the port searches exactly the allowed paths, so disallowed files are never opened and can never crowd out allowed ones.
Under `workspace`, the scope stays the whole tree and the adapter passes `rg` `--iglob` exclusions derived from the same sets the `shouldInclude` policy checks, so the search never opens a file the policy rejects in any include mode.
`EXCLUDE_GLOB` for `findFiles` is untouched; the `rg` globs are a derived representation of the exclusion sets, not a third hand-written copy.
An empty allowed scope (`off`, or `prompt-files` with no allowed paths) returns `emptyResult("excluded")` without calling the port, because there is nothing the policy allows the search to open.
The adapter also refuses an empty scope at the lowest layer, so a direct port caller cannot make `rg` open the tree.
The adapter drops nonexistent path arguments before invoking `rg`, so a stale prompt file shrinks the scope instead of failing the whole search; a measured `rg` run with a missing path argument exits 2 with the error on stderr while the valid path still yields its match on stdout, which the fail-soft envelope would have discarded.

## Considered options

Fix 2 (let the port over-return a larger window and filter before the cap) was rejected: the kept set still depends on arrival order, the budget is still finite, and disallowed files are still opened.
The port stays policy-free: it receives a plain `paths` scope, never the `IncludePolicy`, so the policy remains pure and testable at the code-tools seam.
