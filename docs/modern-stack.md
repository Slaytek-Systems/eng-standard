# Modern Stack v1

Approved by Matt on Thu 15 Oct 2026 (Sydney). The machine-readable floors are in [`standard/modern-stack.yml`](../standard/modern-stack.yml). The reasoning lives in Core, in the Tech Stack Decisions Index (`nd72pb884wwtv122vr5b6kctes86fpt1`) and the decision notes it links. This page is the short view.

| Layer | Standard (floor) | Sanctioned alternative |
|---|---|---|
| Runtime | Bun 1.4.4 (minimum) in `packageManager`, Node 24 LTS for `vp` and servers | pnpm, Kalsigns only |
| Toolchain | Vite+ (`vp`) ≥ 1.2.0, Vite ≥ 8.3 | plain `bun run` oxlint/oxfmt/vitest scripts |
| Framework | SvelteKit ≥ 2.70 + Svelte ≥ 5.57.2 | Astro 7 for static or content sites |
| Backend | Convex ≥ 1.49 on Convex Cloud, on Node ≥ 22; `v.function()` validates function handles | self-hosted Convex on Railway; PlanetScale |
| Auth | Better Auth ≥ 1.6.33 (below 1.7) + `@convex-dev/better-auth` ≥ 0.12.5 | WorkOS AuthKit (`@workos-inc/node` ≥ 11) |
| Styling | Tailwind ≥ 4.3.3 + shadcn-svelte, shadcn Trace for agent UI | none |
| Lint and format | Oxlint ≥ 1.88 (type-aware) + Oxfmt ≥ 0.73; ESLint and Prettier retired (Svelte template linting not covered: decision 3) | none |
| Type-check | TS 7.0.2 as the checker, `typescript` 6.0.3 as the API shim | plain TS 7 where no Svelte, Astro, Next or TS-API tools |
| Test | Vitest ≥ 5.0.4, `convex-test` ≥ 0.0.62, Playwright ≥ 1.64.1 | none |
| AI | `ai` ≥ 7, OpenRouter provider ≥ 3 | none |
| CI pins | Bun 1.4.4 from `packageManager` (minimum 1.4.4), Node 24 from `.node-version` | none |
| Deploy | Railway | Azure, Microsoft-ecosystem clients only |

## Decisions (15 Oct 2026)

1. TS 7 is the checker and `typescript` 6.0 stays alongside until TS 7.1 ships a compiler API. The `typescript` 6.0.3 floor is intended. Repos on TS 5.x (Motus, Infotech, Syncsoon) report drift on the first `--core` run. Motus's modernization lane covers that, and there is no exception.
2. SvelteKit 3 is piloted on Equitus, then Syncsoon. Convex + Better Auth repos wait until the adapter supports Better Auth 1.7.
3. Svelte template linting is not covered: Oxlint plus svelte-check warnings, no ESLint. Matt accepted losing it on 15 Oct 2026.
4. Equitus's host is undecided. Compare real Vercel + Supabase costs against a Railway estimate first.
5. Floors live here. Core keeps the reasoning. Until 0.14.0 a monthly `stack-audit` run filed Core follow-ups; the 6 Nov 2026 CLI cut dropped that command, so the floors are advice, not a check.

## Recorded exceptions

- **Motus**: Next/React.
- **Kalsigns**: Expo/React, pnpm, Azure, SQL Server.
- **slaytek-site**: Astro.
- **Equitus**: host pending (see decision 4).

## Lint

Once a repo is on convex 1.49, `eng lint` rule `convex-function-handle-validator` fails a `fnHandle`- or `functionHandle`-named field validated with `v.string()`, and an `as FunctionHandle<...>` cast, under `convex/`. Use `v.function()` instead. A repo that adopts the standard while shipping baselines its existing hits through `eng init`.

## Not verified

- Vite+ has no official SvelteKit or Next.js guide. SvelteKit fit is inferred from it being a Vite plugin.
- The Convex CLI has not been tested with `typescript` resolving to 7.
