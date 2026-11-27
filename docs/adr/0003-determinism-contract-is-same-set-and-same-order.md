# The determinism contract is same set and same order

Ticket #61 was found because the #18 evaluation re-run produced different workspace-search context from identical inputs (4 of 33 run pairs).
We decided that the promised contract at the `searchText` seam is the strong one: two identical calls on an unchanged tree, query, and policy return the same match set in the same order, and every text-search fallback site inherits it through the shared fallback path.
The weaker promises ("same result set" without order, or only "no allowed match is crowded out") were rejected: order decides which matches survive the cap and what the downstream context fragment contains, so a same-set promise without a same-order promise would still make the #18 A/B pairs incomparable.
Canonical (path, line, character) order is the only order that can be promised across runs, because arrival order depends on `rg` thread scheduling.
