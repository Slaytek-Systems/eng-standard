// eng stack-audit: compare a repo's declared versions against standard/modern-stack.yml floors. Pure; bin/eng.mjs reads the repo.
import YAML from 'yaml';
import semver from 'semver';

// Lowest version a spec allows, as npm's semver resolves it ("^1.46.0" -> "1.46.0", "npm:typescript@7.0.2" -> "7.0.2",
// "^22 || ^20" -> "20.0.0", ">1.48" -> "1.49.0"). null = no proven minimum: not a range (workspace:, git, latest) or no
// lower bound ("*", "<2", "^1.49 || *"). Compare results with semver, which orders a prerelease before its release.
export function minVersion(spec) {
  let s = String(spec ?? '').trim();
  if (/^(workspace:|file:|link:|catalog:|git|https?:|github:)/.test(s) || s === 'latest') return null;
  if (s.startsWith('npm:')) s = s.slice(s.lastIndexOf('@') + 1);
  let v; try { v = semver.minVersion(s); } catch { return null; }
  return v && semver.gt(v, '0.0.0') ? v.version : null;
}
const below = (spec, floor) => { const v = minVersion(spec); return !!v && semver.lt(v, minVersion(floor)); };

export const SKIP_DIRS = /(^|\/)(node_modules|fixtures|examples)\//;

// Declared deps across a repo's package.json files. A monorepo keeps each package's lowest declared minimum: that is the drift.
export function lowestDeps(manifests) {
  const deps = {};
  for (const pj of manifests)
    for (const [n, spec] of Object.entries({ ...pj.dependencies, ...pj.devDependencies })) {
      const v = minVersion(spec), cur = minVersion(deps[n]);
      if (!(n in deps) || (v && (!cur || semver.lt(v, cur)))) deps[n] = spec;
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
    if (below(spec, floor)) add(layer, pkg, spec, `>= ${floor}`);
  }
  for (const [layer, l] of Object.entries(std.layers))
    for (const pkg of l.replaces || []) if (facts.deps[pkg] !== undefined) add(layer, pkg, facts.deps[pkg], `removed (replaced by the ${layer} standard)`);

  const rt = std.layers.runtime, [pmName, pmVer] = rt.package_manager.split('@');
  const [haveName, haveVer] = String(facts.packageManager || '').split('@');
  if (!haveName) add('runtime', 'packageManager', 'unpinned', rt.package_manager);
  else if (haveName !== pmName) add('runtime', haveName, facts.packageManager, rt.package_manager);
  else if (!minVersion(haveVer) || below(haveVer, pmVer)) add('runtime', 'packageManager', facts.packageManager, rt.package_manager);

  for (const [key, label] of [['ciBun', 'bun'], ['ciNode', 'node']]) {
    for (const pin of facts[key] || []) if (below(pin, String(rt.ci[label]))) add('runtime', `ci ${label}`, pin, `>= ${rt.ci[label]}`);
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
// nvm LTS codenames in .nvmrc (lts/iron). An unknown (future) codename is skipped, not failed.
const LTS = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };
const json = s => { try { return JSON.parse(s); } catch { return {}; } };

// Every Node version a repo declares: [{ file, kind, spec }]. files: repo paths; read(file) -> text.
export function nodePins(files, read) {
  const pins = [];
  for (const f of files.filter(f => !SKIP_DIRS.test(f))) {
    const base = f.split('/').pop();
    if (base === 'package.json') { const s = json(read(f)).engines?.node; if (s != null) pins.push({ file: f, kind: 'engines', spec: String(s) }); }
    else if (base === '.nvmrc' || base === '.node-version') { const s = read(f).split('\n').map(l => l.replace(/#.*/, '').trim()).find(Boolean); if (s) pins.push({ file: f, kind: 'version-file', spec: s }); }
    else if (base === 'convex.json') { const s = json(read(f)).node?.nodeVersion; if (s) pins.push({ file: f, kind: 'convex', spec: String(s) }); }
    else if (/^(\.github\/workflows|\.buildkite)\/.*\.ya?ml$/.test(f)) for (const s of ciNodeVersions(read(f))) pins.push({ file: f, kind: 'ci', spec: s });
  }
  return pins;
}

// Every node-version value in a CI YAML file: scalars, lists, and ${{ matrix.<key> }} resolved against the job's strategy.matrix.
function ciNodeVersions(text) {
  let doc; try { doc = YAML.parse(text); } catch { return []; }
  const out = [];
  const walk = (node, matrix) => {
    if (Array.isArray(node)) return node.forEach(n => walk(n, matrix));
    if (!node || typeof node !== 'object') return;
    const m = node.strategy?.matrix && typeof node.strategy.matrix === 'object' ? node.strategy.matrix : matrix;
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'node-version') { walk(v, m); continue; }
      for (const s of [].concat(v).map(String)) {
        const ref = s.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
        out.push(...(ref && m?.[ref[1]] !== undefined ? [].concat(m[ref[1]]).map(String) : [s]));
      }
    }
  };
  try { walk(doc, null); } catch { return []; } // a self-referencing YAML alias
  return out;
}

// Does a Node pin allow any Node below floor.0.0? Its lowest allowed version decides: "<22", "*", ">=*", "" and
// "22.0.0-rc.2" do, ">21" does not. lts/<codename> is its major. A pin that is not a range ("node", "lts/*",
// "${{ matrix.node }}", an unknown codename) is skipped.
function nodeAllowsBelow(spec, floor) {
  const s = String(spec).trim(), lts = s.match(/^lts\/(\w+)$/);
  const range = lts ? (LTS[lts[1]] === undefined ? null : String(LTS[lts[1]])) : semver.validRange(s);
  if (range === null) return false;
  const min = semver.minVersion(range);
  return !min || semver.lt(min, `${floor}.0.0`);
}

// A repo that declares convex must not declare a Node below the backend layer's node floor. Returns [{ ...pin, where, want, fix }].
export function convexNodeFindings(std, deps, pins) {
  const floor = std.layers.backend?.node;
  if (!floor || deps.convex === undefined) return [];
  return pins.filter(p => nodeAllowsBelow(p.spec, floor)).map(p => {
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
  pattern: '\\bas\\s+FunctionHandle\\s*<|\\w*(?:[fF]n|[fF]unction)Handles?[\'"]?\\s*:\\s*v\\.(optional\\(\\s*v\\.)?string\\(\\)',
  flags: '',
  message: 'Function handle validated as a string. Use v.function({ fnType, args, returns }) (convex 1.49+): its type is FunctionHandle_future, so no cast is needed. Existing code: eng renovate baseline --kind lint.',
};
// On only when every package.json that declares convex proves a minimum of `since`, so v.function() exists wherever convex is used.
export function usesHandleRule(manifests) {
  const specs = manifests.map(pj => ({ ...pj.dependencies, ...pj.devDependencies }).convex).filter(s => s !== undefined);
  return specs.length > 0 && specs.every(s => { const v = minVersion(s); return !!v && semver.gte(v, CONVEX_HANDLE_RULE.since); });
}

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
