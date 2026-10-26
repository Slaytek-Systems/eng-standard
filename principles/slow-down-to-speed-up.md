# Slow down to speed up: trust is earned through systems built on formal verification

Source: Core note nd718ymz8781g132npfwcn49198h03zr. The block between the `verbatim` markers is Matt's words, copied byte for byte. Do not edit it. `test/principles.test.mjs` (run by `npm test`) fails if its sha256 changes.

<!-- verbatim:begin -->
## Core (Matt's words, verbatim, 26 Oct 2026 AEDT)
> "And honestly, I think the word confidence is wrong. The word should be trust. The thing that boosts trust is these systems that we are building. And all of these systems we are building are based on the idea of formal verification."

> "with regards to verification, that is where things like pstack And E2E and bend2 and all of the other various checks and linters that we build, that's where all of that's going to come from, right? Some of these are going to be in CI runners. Depending on the project and depending on the engineering standards that we have configured, these things could be happening locally, or they could be happening with some sort of cloud tool like BuildKite, or they could be running in ephemeral sandboxes like through Boat, and all of this stuff is to assessentially create this autonomous software factory that is built upon self-verification."

> "So, you need to be very, very, very fucking careful about what you change. Because if you change my words at any point, there's a chance that your understanding, your comprehension, your actual execution, and any future executions from other agents will also be affected by this cancer, you know, by this rot."

> "automation and speed needs to be earned by building the correct foundations, constraints, tooling, checking, sops, etc. the idea of moving too fast with no comprehension or trust in a system can lead to devastating crashes"

> "it needs to be something that we organically continue to evolve"

<!-- verbatim:end -->

## Interpretation (not Matt's words)

- Verification is the foundation: pstack, E2E, bend2, checks and linters. Where each check runs (local, a cloud runner, an ephemeral sandbox) is a per-repo choice in `eng.config.yml`.
- Automation and speed are earned. A repo gains autonomy only after its checks have shown it can be trusted, and loses it after a crash.
- Matt's words are kept exactly. A paraphrase can drift, and drift spreads to every agent that reads it. That is why the block above is hash-checked.
- The standard keeps evolving. Each incident or revert should leave a new check or guard behind (`guards/LOG.md`).
