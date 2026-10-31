// eng stack-audit: compare a repo's declared versions against standard/modern-stack.yml floors. Pure; bin/eng.mjs reads the repo.

// Lowest version a spec allows ("^1.46.0" -> [1,46,0], "npm:typescript@7.0.2" -> [7,0,2]). null = no minimum (workspace:, git, "<2", ...).
export function minVersion(spec) {
  let s = String(spec ?? '').trim();
  if (/^(workspace:|file:|link:|catalog:|git|https?:|github:)/.test(s) || s === '*' || s === 'latest' || s.startsWith('<')) return null;
  if (s.startsWith('npm:')) s = s.slice(s.lastIndexOf('@') + 1);
  const m = s.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? m.slice(1).map(x => Number(x || 0)) : null;
}

export function cmp(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

export const SKIP_DIRS = /(^|\/)(node_modules|fixtures|examples)\//;

// Declared deps across a repo's package.json files. A monorepo keeps each package's lowest declared minimum: that is the drift.
export function lowestDeps(manifests) {
  const deps = {};
  for (const pj of manifests)
    for (const [n, spec] of Object.entries({ ...pj.dependencies, ...pj.devDependencies })) {
      const v = minVersion(spec), cur = minVersion(deps[n]);
      if (!(n in deps) || (v && (!cur || cmp(v, cur) < 0))) deps[n] = spec;
    }
  return deps;
}

// Every package floor in the standard, with the layer that owns it.
export function floorTable(std) {
  const t = {};
  for (const [layer, l] of Object.entries(std.layers))
    for (const [pkg, v] of Object.entries({ ...l.floors, ...l.alternative_floors })) t[pkg] = { layer, floor: String(v) };
  return t;
}

// facts: { name, deps: {pkg: spec}, packageManager, ciBun: [..], ciNode: [..] } read from the repo by the CLI.
// Returns findings: { repo, layer, item, have, want, status: 'drift' | 'excepted' }.
export function audit(std, facts) {
  const exc = std.exceptions?.[facts.name];
  const allowed = new Set(exc?.allow || []);
  const out = [];
  const add = (layer, item, have, want) => out.push({ repo: facts.name, layer, item, have, want, status: allowed.has(item) ? 'excepted' : 'drift' });

  for (const [pkg, { layer, floor }] of Object.entries(floorTable(std))) {
    const spec = facts.deps[pkg]; if (spec === undefined) continue;
    const have = minVersion(spec), want = minVersion(floor);
    if (have && cmp(have, want) < 0) add(layer, pkg, spec, `>= ${floor}`);
  }
  for (const [layer, l] of Object.entries(std.layers))
    for (const pkg of l.replaces || []) if (facts.deps[pkg] !== undefined) add(layer, pkg, facts.deps[pkg], `removed (replaced by the ${layer} standard)`);

  const rt = std.layers.runtime, [pmName, pmVer] = rt.package_manager.split('@');
  const [haveName, haveVer] = String(facts.packageManager || '').split('@');
  if (!haveName) add('runtime', 'packageManager', 'unpinned', rt.package_manager);
  else if (haveName !== pmName) add('runtime', haveName, facts.packageManager, rt.package_manager);
  else if (cmp(minVersion(haveVer) || [0, 0, 0], minVersion(pmVer)) < 0) add('runtime', 'packageManager', facts.packageManager, rt.package_manager);

  for (const [key, label] of [['ciBun', 'bun'], ['ciNode', 'node']]) {
    const want = minVersion(rt.ci[label]);
    for (const pin of facts[key] || []) { const v = minVersion(pin); if (v && cmp(v, want) < 0) add('runtime', `ci ${label}`, pin, `>= ${rt.ci[label]}`); }
  }
  return out;
}

// Where a repo declares the Node version it runs on: kind -> the key inside the file, and the fix for a pin below the floor.
const NODE_KINDS = {
  engines: { key: 'engines.node', fix: f => `set "engines": { "node": ">=${f}" }` },
  'version-file': { key: '', fix: () => 'write 24 (the Modern Stack CI pin)' },
  ci: { key: 'node-version', fix: () => 'set node-version: 24 in actions/setup-node (or node-version-file: .node-version)' },
  convex: { key: 'node.nodeVersion', fix: f => `set "node": { "nodeVersion": "${f}" } (Convex runs Node actions on 22 or 24)` },
};
const LTS = { hydrogen: 18, iron: 20, jod: 22, krypton: 24 }; // nvm codenames in .nvmrc (lts/iron)
const json = s => { try { return JSON.parse(s); } catch { return {}; } };

// Every Node version a repo declares: [{ file, kind, spec }]. files: repo paths; read(file) -> text.
export function nodePins(files, read) {
  const pins = [];
  for (const f of files.filter(f => !SKIP_DIRS.test(f))) {
    const base = f.split('/').pop();
    if (base === 'package.json') { const s = json(read(f)).engines?.node; if (s) pins.push({ file: f, kind: 'engines', spec: String(s) }); }
    else if (base === '.nvmrc' || base === '.node-version') { const s = read(f).trim().split('\n')[0]; if (s) pins.push({ file: f, kind: 'version-file', spec: s }); }
    else if (base === 'convex.json') { const s = json(read(f)).node?.nodeVersion; if (s) pins.push({ file: f, kind: 'convex', spec: String(s) }); }
    else if (/^(\.github\/workflows|\.buildkite)\/.*\.ya?ml$/.test(f))
      for (const [, v] of read(f).matchAll(/node-version:\s*(\[[^\]]*\]|[^\s#]+)/g))
        for (const s of v.replace(/^\[|\]$/g, '').split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)) pins.push({ file: f, kind: 'ci', spec: s });
  }
  return pins;
}

const nodeMin = spec => { const lts = String(spec).match(/^lts\/(\w+)$/); return lts ? (LTS[lts[1]] ? [LTS[lts[1]], 0, 0] : null) : minVersion(spec); };

// A repo that declares convex must not declare a Node below the backend layer's node floor. Returns [{ ...pin, where, want, fix }].
export function convexNodeFindings(std, deps, pins) {
  const floor = std.layers.backend?.node;
  if (!floor || deps.convex === undefined) return [];
  return pins.filter(p => { const v = nodeMin(p.spec); return v && cmp(v, minVersion(String(floor))) < 0; }).map(p => {
    const k = NODE_KINDS[p.kind];
    return { ...p, where: [p.file, k.key].filter(Boolean).join(' '), want: `>= ${floor}`, fix: k.fix(floor) };
  });
}

// eng lint rule for repos on convex >= since: function handles are validated with v.function(), not v.string() and a cast.
export const CONVEX_HANDLE_RULE = {
  id: 'convex-function-handle-validator',
  since: '1.49.0',
  paths: ['**/convex/**/*.ts', '**/convex/**/*.tsx'],
  exclude: ['**/_generated/**'],
  pattern: '\\bas\\s+FunctionHandle\\s*<|[hH]andle\\w*[\'"]?\\s*:\\s*v\\.(optional\\(\\s*v\\.)?string\\(\\)',
  flags: '',
  message: 'Function handle validated as a string. Use v.function({ fnType, args, returns }) (convex 1.49+): its type is FunctionHandle_future, so no cast is needed. Existing code: eng renovate baseline --kind lint.',
};
export const usesHandleRule = deps => { const v = minVersion(deps.convex); return !!v && cmp(v, minVersion(CONVEX_HANDLE_RULE.since)) >= 0; };

// The run month for idempotency keys, in Sydney where the fleet's owner works, so a run late on the 31st UTC lands in the new month.
export function sydneyMonth(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit' }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}`;
}

// One Core work.followup-create input per drift finding. dedupe_key is stable per repo, item and target, so the caller can skip
// findings that already have an open follow-up. Core replays an idempotency_key for only 7 days, so it carries the run month.
export function corePayloads(std, findings, { space, target, month }) {
  const safe = s => s.replace(/^>= /, '').replace(/ \(.*$/, '').replace(/[^A-Za-z0-9._:-]+/g, '.');
  return findings.filter(f => f.status === 'drift').map(f => {
    const dedupe_key = `stack-audit:v${std.version}:${f.repo}:${safe(f.item)}:${safe(f.want)}`.slice(0, 120);
    return {
      dedupe_key,
      input: {
        space,
        title: `${f.repo}: ${f.item} ${f.have} -> ${f.want} (${std.name})`.slice(0, 200),
        content: `eng stack-audit found ${f.repo} off the ${std.name} standard.\n\nLayer: ${f.layer}\nItem: ${f.item}\nDeclared: ${f.have}\nStandard: ${f.want}\n\nFloors: eng-standard standard/modern-stack.yml. Reasoning: Core ${std.core.why}.`,
        target_type: target.type,
        target_id: target.id,
        priority: 'normal',
        idempotency_key: `${dedupe_key}:${month}`.slice(0, 128),
      },
    };
  });
}
