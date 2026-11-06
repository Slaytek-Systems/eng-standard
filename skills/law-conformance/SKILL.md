---
name: law-conformance
description: "Check that shipped code makes the same decisions as the Bend model, over a finite enumerated domain, with a deliberately broken model as a control. Use after write-law-and-proof, and whenever the app's decision code changes."
---

# Law conformance

Method and runner are vendored from CenterForAgenticAI/tools `pi-intent` intent-conformance (MIT); see `vendor/pi-intent/` in the eng package. Proving LAWS.bend says nothing about shipped code; conformance links them.

1. Enumerate a finite input domain (for example every subtotal and discount in 0..N). Write `.intent/model/Rows.bend`: imports the kernel, prints one `case-id result` row per input.
2. Write `.intent/oracle/<lang>.ts`: imports the real app function and prints the same rows. No decision logic in the oracle. Done: a mutation in app code changes its output.
3. Write `.intent/model/Broken.bend`: the same rows from a deliberately wrong model, wrong for at least one input.
4. Write `.intent/conform.json` (schema 1): one check with `laws`, and argv arrays `model`, `real`, `broken`. `.intent/model/LAWS.bend` links to `laws/LAWS.bend`.
5. Run the vendored runner, `node <eng package>/vendor/pi-intent/kit/intent-conform.mjs .`, and name it in `project.commands.conform` so `eng gate` runs it. Done: `pass <check>: N cases; broken model differs`. Then prove both controls: app drift makes it reject with `conformance drift`, and an oracle that does not call the real code makes it reject with `oracle does not exercise the real code`.
