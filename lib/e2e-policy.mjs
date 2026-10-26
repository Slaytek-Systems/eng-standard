// e2e policy: decides whether a change needs the e2e suite. Pure: config + changed files + labels + event in, decision out.
// PRs: path-based. main after every merge and nightly: always the full suite (the backstop).

// Glob → RegExp. `**/` matches zero or more dirs, `**` anything, `*` anything but `/`. dotAll: a raw newline in a filename
// is still matched by `**`, so it cannot slip a path out of a risk:high or high_risk_paths pattern.
export const glob2re = g => new RegExp('^' + g.replaceAll('**/', '\u0000').split('**').map(p => p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*').replaceAll('\u0000', '(?:.*/)?') + '$', 's');

// Defaults for a TS / Vite / Convex repo. A repo overrides any list in eng.config.yml → e2e.policy.
export const DEFAULT_POLICY = {
  mode: 'path_based',            // path_based | always (always = every PR runs e2e, the pre-v0.4 behaviour)
  labels: ['risk:high'],         // a PR with any of these labels always runs e2e
  unmatched: 'run',              // a file no list matches: run (safe) | skip
  run_on: {                      // any changed file here → e2e required
    e2e: ['**/*.e2e.ts', 'e2e.config.ts', 'e2e/**', 'tests/e2e/**'],
    app: ['src/**', 'app/**', 'convex/**', 'components/**', 'lib/**', 'public/**', 'index.html'],
    routes: ['**/routes/**', '**/pages/**', '**/api/**', '**/router.*', '**/*.routes.*'],
    db: ['migrations/**', '**/migrations/**', '**/schema.*', '**/*.sql', 'prisma/**', 'drizzle/**'],
    build: ['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'vite.config.*', 'tsconfig*.json', 'Dockerfile'],
    ci: ['.github/workflows/**', '.buildkite/**', '.eng/ci/**', 'eng.config.yml', 'e2e.config.*'],
  },
  skip_on: {                     // a PR whose files all land here skips e2e (tests and docs win over run_on: src/x.test.ts is test-only)
    tests: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**', '.eng/checks/**', '.eng/rule-proofs/**'],
    docs: ['**/*.md', '**/*.mdx', 'docs/**', '**/LICENSE*', '.agents/**', '.claude/**'],
    config: ['**/*.json', '**/*.yml', '**/*.yaml', '**/*.toml', '**/.*rc', '**/.*rc.*', '**/.gitignore', '**/.editorconfig', '.githooks/**', 'fallow-baselines/**', '**/.env.example'],
  },
  main: { on_merge: 'full', nightly: { enabled: false, cron: '0 16 * * *' } },  // 03:00 AEDT
};

export function resolvePolicy(e2e) {
  const p = e2e?.policy;
  if (!p) return { ...DEFAULT_POLICY, mode: 'always' };   // no policy section: old behaviour, e2e on every PR
  return {
    ...DEFAULT_POLICY, ...p,
    run_on: { ...DEFAULT_POLICY.run_on, ...(p.run_on || {}) },
    skip_on: { ...DEFAULT_POLICY.skip_on, ...(p.skip_on || {}) },
    main: { ...DEFAULT_POLICY.main, ...(p.main || {}), nightly: { ...DEFAULT_POLICY.main.nightly, ...(p.main?.nightly || {}) } },
  };
}

export function validatePolicy(e2e) {
  const p = e2e?.policy, errs = [];
  if (!p) return errs;
  if (!['path_based', 'always'].includes(p.mode ?? 'path_based')) errs.push('e2e.policy.mode must be path_based or always');
  if (!['run', 'skip'].includes(p.unmatched ?? 'run')) errs.push('e2e.policy.unmatched must be run or skip');
  if (p.main?.on_merge && p.main.on_merge !== 'full') errs.push('e2e.policy.main.on_merge must be full (the post-merge backstop cannot be turned off)');
  for (const k of ['run_on', 'skip_on']) for (const [c, v] of Object.entries(p[k] || {})) if (!Array.isArray(v)) errs.push(`e2e.policy.${k}.${c} must be a list of globs`);
  return errs;
}

const hit = (globs, f) => (globs || []).some(g => glob2re(g).test(f));

// One file → its category. Order: e2e flows → tests/docs (skip) → run_on → config (skip) → unmatched.
export function classify(policy, f) {
  if (hit(policy.run_on.e2e, f)) return { kind: 'run', cat: 'e2e' };
  for (const c of ['tests', 'docs']) if (hit(policy.skip_on[c], f)) return { kind: 'skip', cat: c };
  for (const [c, g] of Object.entries(policy.run_on)) if (c !== 'e2e' && hit(g, f)) return { kind: 'run', cat: c };
  for (const [c, g] of Object.entries(policy.skip_on)) if (!['tests', 'docs'].includes(c) && hit(g, f)) return { kind: 'skip', cat: c };
  return { kind: policy.unmatched === 'skip' ? 'skip' : 'run', cat: 'unmatched' };
}

// event: pr | main | nightly. Returns { required, reason, files: [{file, kind, cat}] }.
export function decide(e2e, { files = [], labels = [], event = 'pr' } = {}) {
  const policy = resolvePolicy(e2e);
  if (event === 'main') return { required: true, reason: 'main after merge: full e2e always runs (backstop)', files: [] };
  if (event === 'nightly') return { required: true, reason: 'nightly: full e2e always runs (backstop)', files: [] };
  if (policy.mode === 'always') return { required: true, reason: 'e2e.policy.mode is always (or no policy set)', files: [] };
  const lab = labels.filter(l => policy.labels.includes(l));
  const cls = files.map(f => ({ file: f, ...classify(policy, f) }));
  if (lab.length) return { required: true, reason: `label ${lab.join(', ')}`, files: cls };
  if (!files.length) return { required: false, reason: 'no changed files', files: cls };
  const run = cls.filter(c => c.kind === 'run');
  if (run.length) {
    const cats = [...new Set(run.map(c => c.cat))];
    return { required: true, reason: `touches ${cats.join(', ')} (${run.slice(0, 3).map(c => c.file).join(', ')}${run.length > 3 ? ', ...' : ''})`, files: cls };
  }
  return { required: false, reason: `only ${[...new Set(cls.map(c => c.cat))].join(' + ')} changes`, files: cls };
}
