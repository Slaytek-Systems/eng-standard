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
export const flakeRunsOf = cfg => cfg?.verification?.flake_runs ?? 1;
export function checkErrors(v) {
  const e = [];
  if (v?.checks_dir !== undefined && !(typeof v.checks_dir === 'string' && v.checks_dir.trim())) e.push('verification.checks_dir must be a path');
  if (v?.flake_runs !== undefined && !(Number.isInteger(v.flake_runs) && v.flake_runs >= 1)) e.push('verification.flake_runs must be an integer >= 1');
  return e;
}
// names: the .sh files in the checks dir. read(p): file text. exists(p): a covered path is there. quote: a shell word.
// Returns one gate step per check: { name, cmd } or { name, fail } when a covered path is gone.
export function checkSteps({ dir, names, read, exists, runs, quote }) {
  return names.filter(f => f.endsWith('.sh')).sort().map(f => {
    const id = f.slice(0, -3), p = `${dir}/${f}`, covers = (read(p).match(/^# covers: (.+)$/m)?.[1] || '').split(/\s+/).filter(Boolean), gone = covers.filter(c => !exists(c));
    if (gone.length) return { name: `check:${id}`, fail: `check ${id} is stale: covers missing path(s) ${gone.join(' ')}` };
    return { name: `check:${id}`, cmd: `p=0; for i in $(seq ${runs}); do bash ${quote(p)} && p=$((p+1)); done; if [ "$p" = ${runs} ]; then echo "check ${id}: passed ${runs}/${runs}"; elif [ "$p" = 0 ]; then echo "eng: FAIL check ${id}: failed ${runs}/${runs}"; exit 1; else echo "eng: FAIL check ${id}: FLAKY, passed $p/${runs}"; exit 1; fi` };
  });
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
  if (bad) return `verification PASS includes a failing run (${bad.cmd} exited ${bad.exit})`;
  return null;
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
