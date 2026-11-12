// Verification tooling shows the work is sound (Matt, 6 Nov 2026; Core nd716pq0vffa13z4c99e09552x8hqwp3). It is its own
// dimension, so who runs it does not matter: the builder may verify its own work. A verifier (a tool, lane or agent, named by
// --by) runs the change against the exact commit through `eng run --by <id> -- <cmd>`. Each run records the
// command, its exit code, its output tail and the commit SHA. `eng verdict PASS|FAIL --by <id>` then attaches that verifier's
// runs for HEAD to the verdict as its evidence. Which verifiers a repo runs is its own choice. A review verdict (`--review`)
// is the required check only when every changed file is text that no check can run (review_only_paths). On testable code a
// review is optional: its FAIL still blocks, but its PASS does not stand in for verification. Self-merge, eng merge gate and
// eng verdict check all apply passProblem(), so the three gates hold one rule.
import fs from 'node:fs';
import path from 'node:path';
import { glob2re } from './e2e-policy.mjs';
import { checkSpec, PARALLEL_DEFAULT } from './budget.mjs';

export const METHODS = ['verification', 'review'];
export const REVIEW_ONLY_DEFAULT = ['**/*.md', '**/*.mdx', '**/*.txt', '**/LICENSE*'];
export const OUTPUT_TAIL = 2000;

export const reviewOnlyPaths = cfg => cfg?.verification?.review_only_paths ?? REVIEW_ONLY_DEFAULT;
// ---------- the checks: every script in verification.checks_dir is a wall eng gate runs ----------
// Matt, 7 Nov 2026: the scripts are the wall, not a verb to tidy away. eng gate runs them first, whatever gates.required
// says, so a command or gate rename cannot drop them. A check fails the gate when any of its flake_runs runs fails, or
// when a path its `# covers:` line names is gone.
export const CHECKS_DIR = '.eng/checks';
export const checksDir = cfg => cfg?.verification?.checks_dir ?? CHECKS_DIR;
// eng gate --event pr (a pull request) runs each check verification.flake_runs_pr times, default flake_runs; every other run
// keeps flake_runs. A PR cannot act on a flake, because a flaky check fails the PR either way; main's run catches it.
export const EVENTS = ['pr', 'main'];
export const flakeRunsOf = (cfg, event) => (event === 'pr' ? cfg?.verification?.flake_runs_pr : undefined) ?? cfg?.verification?.flake_runs ?? 1;
// verification.parallel: how many checks run at once, side by side while their budgets fit (lib/budget.mjs admit). false or
// unset: 1, so checks that share state keep working after an upgrade. true: PARALLEL_DEFAULT. A whole number: that many.
export const parallelOf = cfg => { const p = cfg?.verification?.parallel; return p === true ? PARALLEL_DEFAULT : Number.isInteger(p) ? p : 1; };
// verification.pr_checks: all (default) runs every check on a PR; affected runs a check only when the PR changed a path
// its `# covers:` line names (affectedBy).
export const PR_CHECKS = ['all', 'affected'];
export const prChecksOf = cfg => cfg?.verification?.pr_checks ?? 'all';
export function checkErrors(v) {
  const e = [];
  if (v?.checks_dir !== undefined && !(typeof v.checks_dir === 'string' && v.checks_dir.trim())) e.push('verification.checks_dir must be a path');
  if (v?.flake_runs !== undefined && !(Number.isInteger(v.flake_runs) && v.flake_runs >= 1)) e.push('verification.flake_runs must be an integer >= 1');
  if (v?.flake_runs_pr !== undefined && !(Number.isInteger(v.flake_runs_pr) && v.flake_runs_pr >= 1 && v.flake_runs_pr <= (v.flake_runs ?? 1))) e.push(`verification.flake_runs_pr must be an integer from 1 to verification.flake_runs (${v.flake_runs ?? 1}): it can only lower the count for pull requests`);
  if (v?.parallel !== undefined && !(typeof v.parallel === 'boolean' || (Number.isInteger(v.parallel) && v.parallel >= 1))) e.push(`verification.parallel must be true, false or a whole number >= 1 (default false: checks run one after another; true: up to ${PARALLEL_DEFAULT} at once)`);
  if (v?.pr_checks !== undefined && !PR_CHECKS.includes(v.pr_checks)) e.push(`verification.pr_checks must be ${PR_CHECKS.join(' or ')} (default all: a pull request runs every check)`);
  // Only under pr_checks: affected, so a repo with none of the new keys validates as in 0.21.1.
  if (v?.pr_checks === 'affected' && typeof v.checks_dir === 'string' && v.checks_dir.trim() && repoRel(v.checks_dir) === null) e.push(`verification.checks_dir (${v.checks_dir}) leaves the repo; with verification.pr_checks: affected it must be a path inside it`);
  return e;
}
// A change to these runs every check on a PR: they decide what the checks are and how eng runs them.
export const ENG_CONFIG_FILES = ['eng.config.yml', '.eng/lock.json'];
// A covered path is normalised against the repo root (other/../src is src); one that leaves the repo is a config error.
const normal = p => path.posix.normalize(p).replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';
const inRepo = p => !p.startsWith('/') && !/^\.\.(\/|$)/.test(path.posix.normalize(p));
const clean = p => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
// checks_dir as git names it: relative to the repo root, the way the gate opens it (path.join(ROOT, dir)), so .eng//checks,
// ./.eng/checks/, other/../.eng/checks and /.eng/checks are all .eng/checks. null when it leaves the repo.
export const repoRel = dir => { const r = path.posix.relative('/r', path.posix.join('/r', dir)); return /^\.\.(\/|$)/.test(r) ? null : r; };
const GLOB = /[*?[\]{}]/;
const under = (f, p) => p === '' || p === '.' || f === p || f.startsWith(`${p}/`);
// Which checks a pull request runs under pr_checks: affected. files: the PR's changed paths against the merge base, or
// null when eng could not compute them (why says so). Returns { all: <why every check runs> } or
// { runs(check) }: a check runs when it has no `# covers:` line or a changed path is a covered path or lies under one.
// It fails closed: an unknown or empty diff, or a change to eng's config or the checks dir, runs every check.
// reach(p): the repo-relative real paths p stands for (its real path, symlinks in any folder resolved, and the real path of
// each symlink under it), or null when one leaves the repo or cannot be resolved (with loose, only when p itself does). Git names a symlink, never its target, so
// without this a symlinked check, checks dir or covered path whose target alone changed would be skipped. Each path the
// selector compares matches a changed path lexically or through reach, and a changed path that is a folder on its way
// (a retargeted symlink) matches too: a change under the checks dir's real paths runs
// every check, and a check whose file or covered path reach cannot place inside the repo always runs. Matching only ever
// gains checks over the lexical rule.
export function affectedBy(files, dir, why = 'the diff against the merge base is unknown', reach = () => []) {
  if (files == null) return { all: why };
  if (!files.length) return { all: 'the diff against the merge base is empty' };
  const d = repoRel(dir);
  if (d === null) return { all: `verification.checks_dir ${dir} leaves the repo` };
  // f reaches p when it is p, lies under it, or is a folder on p's way (a retargeted or replaced symlink, a folder now a file).
  const hitIn = ps => files.find(f => ps.some(p => under(f, p) || under(p, f)));
  const hit = files.find(f => ENG_CONFIG_FILES.includes(f) || under(f, d) || under(d, f));
  if (hit) return { all: `${hit} changed` };
  // loose: a link under the checks dir that cannot be placed is left out here; that check's own reach is null, so it runs.
  const dr = reach(d, true);
  if (dr === null) return { all: `verification.checks_dir ${dir} resolves outside the repo or cannot be resolved` };
  const real = hitIn(dr);
  if (real) return { all: `${real} changed, a real path of verification.checks_dir ${dir} or of a check in it` };
  const reaches = p => { const r = reach(p); return r === null || hitIn([clean(p), ...r]) !== undefined; };
  return { runs: c => (c.path !== undefined && reaches(c.path)) || !c.covers.length || c.covers.some(reaches) };
}
// entries: what the checks dir holds, as [name, kind] with kind 'file', 'dir' or 'other'; null when the dir is missing.
// configured: verification.checks_dir is set, so a missing dir is a failure, not "no checks". read(p): file text.
// exists(p): a covered path is there. Returns gate steps: { name, check: { id, path, runs, covers, weight, budget, declared, serial? } }, or
// { name, fail } for a stale check, a header eng cannot read, or an entry eng cannot run as a check. Only <dir>/*.sh files
// are checks; anything else there fails, so a move or rename never drops one. Weight and budget: lib/budget.mjs.
// select: verification.pr_checks: affected is set. Then every # covers: line counts, paths are normalised, one outside the
// repo fails, and a glob fails with its own message (globs are not expanded). Without it covers are read exactly as in 0.21.1.
export function checkSteps({ dir, entries, configured, read, exists, runs, select = false }) {
  if (entries == null) return configured ? [{ name: 'checks', fail: `verification.checks_dir ${dir} does not exist; create it or fix the path` }] : [];
  const bad = entries.filter(([n, k]) => !(n === '.gitkeep' && k === 'file') && !(k === 'file' && n.endsWith('.sh') && n.length > 3));
  return [...bad.map(([n, k]) => ({ name: 'checks', fail: `${dir}/${n} is not a check: checks are ${dir}/<id>.sh files${k === 'dir' ? ', with no subdirectories' : ''}` })),
    ...entries.filter(e => !bad.includes(e) && e[0] !== '.gitkeep').map(([f]) => f).sort().map(f => {
      const id = f.slice(0, -3), p = `${dir}/${f}`, text = read(p);
      // Without select this is 0.21.1's parser: the first # covers: line, taken as written.
      const raw = select ? [...text.matchAll(/^# covers: (.+)$/gm)].flatMap(m => m[1].split(/\s+/)).filter(Boolean) : (text.match(/^# covers: (.+)$/m)?.[1] || '').split(/\s+/).filter(Boolean);
      const out = select ? raw.filter(c => !inRepo(c)) : [], covers = select ? raw.filter(inRepo).map(normal) : raw, gone = covers.filter(c => !exists(c));
      if (out.length) return { name: `check:${id}`, fail: `check ${id}: "# covers:" in ${p} names path(s) outside the repo (${out.join(' ')}); name paths inside it` };
      const globs = select ? gone.filter(c => GLOB.test(c)) : [];
      if (globs.length) return { name: `check:${id}`, fail: `check ${id}: "# covers:" in ${p} names glob(s) ${globs.join(' ')}; globs are unsupported. Name each file or folder the check protects (a folder covers everything under it)` };
      if (gone.length) return { name: `check:${id}`, fail: `check ${id} is stale: covers missing path(s) ${gone.join(' ')}. Point the "# covers:" line in ${p} at the files this check protects now (after a rename, the new path), then run eng gate again` };
      const spec = checkSpec(text);
      if (spec.error) return { name: `check:${id}`, fail: `check ${id}: ${p} ${spec.error}` };
      return { name: `check:${id}`, check: { id, path: p, runs, covers, ...spec } };
    })];
}

export function reviewOnlyErrors(v) {
  if (v?.review_only_paths === undefined) return [];
  const g = v.review_only_paths;
  return Array.isArray(g) && g.every(x => typeof x === 'string' && x.trim()) ? [] : ['verification.review_only_paths must be a list of globs (text no check can run, such as docs and policy)'];
}

// files: the changed paths, or null when the list is unknown. Unknown is never evidence of "nothing to test".
export const testableFiles = (files, globs) => files == null ? null : files.filter(f => !globs.some(g => glob2re(g).test(f)));

// A verdict with no method predates this rule: it was a reading of the diff, so it counts as a review.
export const methodOf = v => v?.method === 'verification' ? 'verification' : 'review';

const isRun = (r, sha) => r && typeof r.cmd === 'string' && r.cmd.trim() && Number.isInteger(r.exit) && typeof r.output === 'string' && r.sha === sha;

// Why a PASS does not count for a change whose testable files are `testable` (null: unknown), or null when it counts.
// A FAIL is not judged here: any FAIL blocks, whatever its method.
export function passProblem(v, testable) {
  if (methodOf(v) === 'review') {
    if (testable == null) return 'review-only PASS, and the changed files are unknown, so the change must be verified';
    if (testable.length) return `review-only PASS on testable code (${testable.slice(0, 3).join(', ')}${testable.length > 3 ? ', ...' : ''}): run it with eng run --by <id> -- <cmd>`;
    return null;
  }
  const runs = Array.isArray(v.runs) ? v.runs : [];
  if (!runs.length) return 'verification PASS lists no runs';
  if (!runs.every(r => isRun(r, v.sha))) return `verification PASS has a run that is not a command, exit code and output on ${String(v.sha).slice(0, 8)}`;
  const bad = runs.find(r => r.exit !== 0);
  return bad ? `verification PASS includes a failing run (${bad.cmd} exited ${bad.exit})` : null;
}

// ---------- the run log: one JSON line per eng run, in the clone's git common dir ----------
export const runLog = commonDir => path.join(commonDir, 'eng', 'verdict-runs.jsonl');
export function recordRun(file, run) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(run) + '\n');
}
// The evidence `by` has for `sha`: the latest run of each distinct command, in the order they last ran. Nothing ages out, so
// a failing command stays failing until that same command passes again; other passing commands never hide it.
// A run's command identity. Since 0.14.0 (v: 2) cmd is the quoted argv. Before, it was the argv joined by spaces, so
// `sh -c 'exit 7'` and `sh -c exit 7` looked alike. Older records keep their own key: a new run never supersedes one.
export const RUN_KEY_VERSION = 2;
const runKey = r => r.v === RUN_KEY_VERSION ? r.cmd : `v1\0${r.cmd}`;
export function runsFor(file, sha, by) {
  if (!fs.existsSync(file)) return [];
  const latest = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.sha === sha && r.by === by) { const k = runKey(r); latest.delete(k); latest.set(k, r); }
  }
  return [...latest.values()];
}
export const tail = s => s.length > OUTPUT_TAIL ? s.slice(-OUTPUT_TAIL) : s;
