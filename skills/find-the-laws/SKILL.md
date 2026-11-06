---
name: find-the-laws
description: "Find candidate laws in a repo: money, permissions, state transitions, deletion, idempotency, limits, pagination, pricing and dates. Use before writing any LAWS.bend or property test, or when asked what must always be true."
---

# Find the laws

A law is a rule that holds for ALL inputs, stated in plain words a human can approve. You find candidates; the rule owner approves them.

1. Search the repo for hotspots: money, permissions, state transitions, deletion, idempotency, limits, pagination and dates. Done: `.eng/laws-candidates.md` lists files ranked by hotspot hits.
2. Read the top files. For each hotspot, write one candidate law in plain words using the shapes in [CATALOGUE.md](CATALOGUE.md). Done: each candidate names the function it constrains and quantifies over all inputs ("for every cart and every discount ...").
3. Rank by blast radius: money and permissions first, then deletion, state, idempotency, limits, pagination, dates. Mark each `Bend` (pure decision, small domain) or `property test` (needs IO, DB or floats).
4. Write the ranked list into `.eng/laws-candidates.md` under `## Proposed laws` and stop for approval. Done: the rule owner has a list of at most 10 laws to approve or strike. Only approved laws go to `write-law-and-proof` or `property-test`.
