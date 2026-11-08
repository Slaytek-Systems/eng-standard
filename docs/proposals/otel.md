# OpenTelemetry in the standard (DRAFT)

**Status: DRAFT, pending Matt's decision.** Nothing here is wired in. No config key, gate, template, check or rendered
file reads this document. Adopting any piece is a separate PR with its own risk class (table below).

Researched 3 Nov 2026 from primary sources (links at the end). OpenTelemetry (OTel) is the vendor-neutral standard for
traces, metrics and logs. Stability labels below are OTel's own: Stable, RC (release candidate), Development, Alpha, Beta.

## Why

Matt decided on 3 Nov 2026 (Core `nd7dhs8666vb7cd79t6m2e5bnx8hhhae`, PR #42) that the independent check runs the change
instead of reading the diff. Today a run's evidence is its command, exit code, output tail and SHA. That proves the
command passed. It does not show what ran: which routes, which backend calls, where the time went, what failed and was
retried. OTel can record that as a trace bound to the exact commit, in a format any tool can read, at no cost when kept
local.

## What exists today (Nov 2026)

- **JS SDK.** Traces and metrics are Stable; logs went Stable in the 3.0 line (20 Oct 2026). `@opentelemetry/sdk-node`
  is 0.300.0 and needs Node >= 22.15. Stable and experimental packages must be upgraded together.
- **Bun is an unsupported runtime.** HTTP server spans stop on Bun >= 1.4.4 (opentelemetry-js #7226, open). So app
  instrumentation runs under Node 24, which the Modern Stack already uses for servers.
- **Commit and CI attributes are RC:** `vcs.ref.head.revision`, `vcs.repository.url.full`, `vcs.change.id`,
  `cicd.pipeline.*`, and the CI/CD span shapes. `service.version` and `deployment.environment.name` are Stable. Test
  attributes (`test.case.name`, `test.suite.*`) are Development.
- **Context through CI.** The env-var carrier spec (`TRACEPARENT`) is RC. Buildkite's agent exports job traces with
  `--opentelemetry-tracing` and sets `TRACEPARENT` for every job command. GitHub Actions has only a webhook receiver
  (Alpha) and community actions.
- **Frameworks.** SvelteKit has built-in server tracing (since 2.31). Vitest has `experimental.openTelemetry` (still
  experimental in 5.1, with a stated performance cost). Playwright has no official OTel reporter, only community ones.
- **Convex** exports no traces and no OTLP. Its log streams (Pro plan) carry a `request_id`. Railway runs a trace-only
  OTLP receiver in preview.
- **Local, free storage.** The Collector's `fileexporter` (Alpha) writes OTLP JSON lines to a file, which fits
  `.eng/evidence/<sha>/`. The `redaction` processor (Beta for traces) keeps only allow-listed attributes.

## Proposed conventions

**Every signal carries these resource attributes** (set through `OTEL_RESOURCE_ATTRIBUTES`, so no code change):

| Attribute | Value | Stability |
|---|---|---|
| `service.name` | the app or service name from `.eng/project.toml` | Stable |
| `service.version` | the release version in production; the head SHA in dev, test and CI | Stable |
| `deployment.environment.name` | `development`, `test`, `staging` or `production` | Stable |
| `vcs.ref.head.revision` | full head SHA | RC |
| `vcs.repository.url.full` | the GitHub URL | RC |
| `vcs.change.id` | PR number, when there is one | RC |
| `eng.patch_id`, `eng.run.id` | the verdict's patch-id; `ENG_RUN_ID` | ours (`eng.*` namespace) |

**Traces.** One root span per `eng run --by` round, `eng gate` step and CI task, shaped like the CI/CD semconv task span.
Child commands join it through `TRACEPARENT`. Span names stay low-cardinality (`GET /orders/{id}`, never the raw URL).
An e2e test sends `traceparent` on its browser requests, so one trace runs from the test to the SvelteKit server.
Convex calls log their `request_id` on the calling span, since Convex cannot join the trace.

**Metrics.** Few, and only with low-cardinality labels: the Stable HTTP server duration histogram, plus our own
`eng.gate.duration` and `eng.e2e.tests` (by result). Never a SHA, user id or URL as a metric label.

**Logs.** Structured JSON through the OTel logs API, each record with `trace_id` and `span_id`. Never secrets, tokens,
emails or request bodies. Redaction is a collector allow-list, and it is one line of defence, not the only one.

## How it helps the verification-first check

1. **Evidence tied to the exact commit.** Each run's trace carries `vcs.ref.head.revision` and `eng.patch_id`. `eng`
   can check that every span in a trace file names the verdict's head SHA. A trace from another commit is rejected the
   same way a run on another commit is. That makes "this evidence is for this commit" a machine check, not a claim.
2. **E2E traces as evidence.** A failing journey leaves a trace showing the request that failed and the server span
   under it, next to the Playwright trace and screenshot already kept.
3. **The verdict records the trace, it is not gated by it.** PASS and FAIL stay on exit codes. The verdict stores the
   trace file's sha256 and trace id, so a later reader can fetch exactly what the verifier saw.

## Minimal starter-pack default (proposed)

1. **Conventions only, no dependency.** `eng gate` and `eng run` set `OTEL_RESOURCE_ATTRIBUTES`
   (the table above) and a fresh `TRACEPARENT` for every child. An app that already uses OTel gets commit-tagged
   telemetry for free. An app that does not is unaffected. No exporter, no network, nothing written.
2. **Local capture, opt in per repo** (`otel.capture: local`). A verdict round starts a pinned Collector (fetched once
   as a pinned, sha256-checked download) bound to 127.0.0.1, with the redaction allow-list and `fileexporter` writing
   `.eng/evidence/<sha>/otel/<round>.jsonl`. Stopped and checked by `eng run` like any other run.
3. **App instrumentation is the repo's choice.** SvelteKit's built-in tracing and `@opentelemetry/sdk-node` 3.x under
   Node 24, exporting OTLP to localhost only. Remote export is off unless Matt approves a backend.

## Renovation path (proposed step 8, `observability`, one PR each)

1. **Audit** (read-only): find OTel packages, vendor SDKs (Sentry, Datadog, Axiom), `OTEL_*` env and Bun-hosted servers.
   Report present, partial or missing like every renovation item.
2. **Attributes:** set the resource attributes in the repo's launch and CI. No code change.
3. **Local capture:** turn on step 2 of the starter default for verdict rounds.
4. **Converge:** move vendor SDKs to OTLP behind the same backend, rename attributes to the conventions, and move any
   Bun-hosted server that needs traces to Node.
5. **Redaction review:** the allow-list goes through review like a baseline, owned in CODEOWNERS.

## Risk class of each piece

eng-standard's rule: any change under `bin/`, `scripts/`, CI, package dependencies or vendored code is risk:high (Matt
merges). Data leaving the machine needs Matt's decision whatever the path.

| Piece | Risk | Why |
|---|---|---|
| This conventions doc, adopted as a standard doc | risk:low | docs only |
| eng sets `OTEL_RESOURCE_ATTRIBUTES` and `TRACEPARENT` for children | risk:high | `bin/`; changes the environment of every repo's gate runs |
| Local Collector capture in verdict rounds | risk:high | `bin/`, a pinned download, merge-gate evidence |
| Verdict stores the trace hash; `eng` checks trace SHA matches head | risk:high | the merge gate |
| Renovation step 8 audit item | risk:low in docs, risk:high once `lib/renovate*.mjs` changes | pack code feeds every repo |
| App SDK in a client repo, exporting to localhost | the client repo's rule (dependency change) | no data leaves the machine |
| Buildkite `--opentelemetry-tracing` in a client's CI | risk:high | CI config; job logs can carry secrets |
| Any remote backend (Railway traces, Axiom, Grafana Cloud, Datadog) | Matt decides | data leaves the machine; cost; PII |
| Convex log streams | Matt decides | Pro plan cost; data leaves Convex |

## Not verified

- Whether the community Playwright OTel reporters are stable enough to block on. Treat them as report-only.
- Whether self-hosted Convex supports log streams.
- The exact SvelteKit 2.x option names (the current docs describe SvelteKit 3 config).
- Collector overhead on the devbox during concurrent verdict rounds. Measure before step 2 of the starter default.

## Decisions for Matt

1. Adopt the conventions as a standard doc (risk:low)?
2. Ship starter default step 1 (attributes and `TRACEPARENT` from eng, no dependency)?
3. Allow a pinned Collector binary on the devbox and in CI for local capture?
4. Any remote telemetry backend at all, and if so which one? Default answer in this draft: none.

## Sources

- OTel JS: https://github.com/open-telemetry/opentelemetry-js and its releases page; Bun issue https://github.com/open-telemetry/opentelemetry-js/issues/7226
- Semantic conventions registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/ (service, deployment, vcs, cicd, test); CI/CD spans: https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/
- Env-var context carriers: https://opentelemetry.io/docs/specs/otel/context/env-carriers/
- Buildkite tracing: https://buildkite.com/docs/agent/v3/tracing
- Collector GitHub receiver: https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.157.0/receiver/githubreceiver
- File exporter: https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/fileexporter; redaction processor: https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/redactionprocessor
- Sensitive data guidance: https://opentelemetry.io/docs/security/handling-sensitive-data/
- SvelteKit observability: https://svelte.dev/docs/kit/observability; Vitest: https://vitest.dev/config/experimental
- Playwright community reporter: https://github.com/endformdev/playwright-opentelemetry
- Convex log streams: https://docs.convex.dev/production/integrations/log-streams; Railway tracing: https://docs.railway.com/observability/tracing
- GenAI conventions (Development): https://github.com/open-telemetry/semantic-conventions-genai
