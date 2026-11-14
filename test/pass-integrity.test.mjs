// No run that was stopped, skipped, deferred, timed out or budget-killed can ever count as PASS evidence (Matt, 9 Nov 2026;
// Core p57b11gp2tawh97mq2112k4r398ht3fs). PR 50 took 11 verdict rounds and about 20 defects of one class: a run that did not
// fully run still counted as passing. This file closes the class by enumerating the outcome space instead of one case at a time.
//
// How a PASS is decided. `eng run --by <id> -- <cmd>` (lib/run.mjs) runs the command under its budget (lib/budget.mjs) and
// appends one record { v, sha, by, cmd, exit, output, at } to <git common dir>/eng/verdict-runs.jsonl (recordRun). The record
// carries no deferral, stop or notice flag: the recorder folds each of them into a nonzero exit (a deferring gate exits 3; a
// nested gate's SIGURG notice turns the command's 0 into 3, lib/nested.mjs; a budget stop is never 0; a signal is 128+n).
// `eng verdict PASS --by <id>` takes runsFor(log, HEAD, id) (each distinct command's latest run, keyed by RUN_KEY_VERSION) and
// refuses locally when there is none or one exited nonzero; without --pr nothing leaves the machine. Self-merge, eng merge gate
// and eng verdict check then apply passProblem() to the verdict and its runs.
//
// The outcome table: every dimension the recorder and the verdict code can observe.
//   Recorder (end to end, through the CLI; 6 x 2 x 2 = 24 rows, each a real `eng run --by` and `eng verdict PASS`):
//     command outcome  exit 0 | exit 1 | exit 3 | exit 124 (timeout) | killed by SIGKILL (137, a budget kill) | killed by SIGTERM
//     budget           not stopped | stopped by its timeout (the command traps TERM and ends with the outcome above)
//     nested gate      none | an inner `eng gate` that deferred a heavy check, its exit 3 swallowed (> /dev/null; then the outcome)
//     plus eng itself signalled while the command traps TERM and exits 0 (one row).
//     command identity  a run that exited 3, then: the same argv passing | an argv whose words join to the same text | another
//                      command (3 rows; only the same argv supersedes the failure).
//   Verdict (pure, recordRun -> runsFor -> the verdict record -> passProblem, self-merge and eng merge gate):
//     one run          exit 0 | 1 | 3 | 124 | 137 | 143  x  SHA head | other  x  --by this | another  x  run key v2 | old (no v)
//                      x  output neutral | claims success                                                  = 96 runs
//     a run log        no earlier run | any of the 96, then any of the 96  x  same command | another command  = 97 x 96 x 2
//                      = 18624 rows; and each of the 96 carried directly in a verdict (a comment from another head) = 96 rows.
//
// The property. PASS is accepted only when at least one run counts, every counted run is on the exact head and by this verifier,
// and every counted run exited 0 (nothing deferred, stopped or noticed, all of which the recorder writes as nonzero). Counted
// runs: per command identity, the latest; identity is the command plus its key version, so a v2 run never supersedes an old
// record of the same command, and the reverse. Output text never counts. Every other combination is refused with a message
// naming why: no runs, a run off the head, or the command and the exit code that failed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import YAML from 'yaml';
import { passProblem, recordRun, runsFor, RUN_KEY_VERSION } from '../lib/verification.mjs';
import { selfMergeConfig, decide } from '../lib/self-merge.mjs';
import { gateDecision, autoConfig } from '../lib/merge-queue.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const C = selfMergeConfig(YAML.parse(fs.readFileSync(path.join(PKG, 'eng.config.yml'), 'utf8')));
const Q = autoConfig(YAML.parse(fs.readFileSync(path.join(PKG, 'templates/merge-auto/eng.config.yml'), 'utf8')));

const product = dims => Object.entries(dims).reduce((rows, [k, vs]) => rows.flatMap(r => vs.map(v => ({ ...r, [k]: v }))), [{}]);

// ---------- verdict: the pure product ----------
const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40), ME = 'pass-integrity', FILES = ['src/app.ts'];
const EXITS = [0, 1, 3, 124, 137, 143];
const RUNS = product({ exit: EXITS, sha: ['head', 'other'], by: ['self', 'other'], v: ['current', 'old'], output: ['neutral', 'claims-success'] });
const OUTPUT = { neutral: 'ran\n', 'claims-success': '# pass 364\n# fail 0\nPASS: all checks green (exit 0)\n' };
const record = (r, cmd) => ({ ...(r.v === 'current' ? { v: RUN_KEY_VERSION } : {}), sha: r.sha === 'head' ? HEAD : OTHER, by: r.by === 'self' ? ME : 'someone-else', cmd, exit: r.exit, output: OUTPUT[r.output], at: '2026-11-09T00:00:00Z' });
// The verdict `eng verdict PASS` records from those runs, as a trusted comment the PR gates read.
const verdict = runs => ({ sha: HEAD, patch_id: 'p1', result: 'PASS', by: ME, method: 'verification', login: 'Mattslayga', association: 'OWNER', comment_at: '2026-11-09T00:00:01Z', at: '2026-11-09T00:00:01Z', ...(runs.length ? { runs: runs.map(({ cmd, exit, output, sha, at }) => ({ cmd, exit, output, sha, at })) } : {}) });
const judges = v => {
  const p = passProblem(v, FILES);
  const sm = decide({ number: 1, base: 'main', draft: false, sameRepo: true, headSha: HEAD, labels: ['risk:low'] }, { risk: 'low', containsBase: true, check: { head_sha: HEAD, status: 'completed', conclusion: 'success' }, statuses: [{ id: 1, state: 'success', context: 'verdict', created_at: '2026-11-09T00:00:02Z', updated_at: '2026-11-09T00:00:02Z', creator: { login: 'Mattslayga' }, description: null, target_url: null }], verdicts: [v], files: FILES }, C);
  const mg = gateDecision({ bind: { kind: 'head', sha: HEAD, upToDate: true }, files: FILES, verdicts: [v], q: Q });
  return { passProblem: p, 'self-merge': sm.merge ? null : sm.reason, 'eng merge gate': mg.pass ? null : mg.reasons.join('; ') };
};

// The property, from the requirement: which runs count, and why a PASS from them is refused (null: accepted).
const counts = r => r.sha === 'head' && r.by === 'self';
function refusal(log) {
  const counted = [];
  for (const e of log.filter(e => counts(e.run))) {
    const i = counted.findIndex(c => c.cmd === e.cmd && c.run.v === e.run.v);
    if (i >= 0) counted.splice(i, 1);
    counted.push(e);
  }
  if (!counted.length) return /lists no runs/;
  const bad = counted.find(c => c.run.exit !== 0);
  return bad ? new RegExp(`\\(${bad.cmd} exited ${bad.run.exit}\\)`) : null;
}

let scratch;
before(() => { scratch = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-pass-integrity-')); });
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('the verdict product: a PASS is accepted exactly when every counted run is on the head, by this verifier, and exited 0', () => {
  const rows = product({ first: [null, ...RUNS], second: RUNS, command: ['same', 'another'] });
  assert.equal(rows.length, 97 * 96 * 2);
  const file = path.join(scratch, 'verdict-runs.jsonl');
  let accepted = 0;
  for (const row of rows) {
    const log = [...(row.first ? [{ run: row.first, cmd: 'npm test' }] : []), { run: row.second, cmd: row.command === 'same' ? 'npm test' : 'node bin/eng.mjs gate' }];
    fs.rmSync(file, { force: true });
    for (const e of log) recordRun(file, record(e.run, e.cmd));
    const want = refusal(log), got = judges(verdict(runsFor(file, HEAD, ME))), name = JSON.stringify(row);
    for (const [gate, why] of Object.entries(got)) {
      if (want === null) assert.equal(why, null, `${gate} refused an honest PASS: ${name}`);
      else { assert.notEqual(why, null, `${gate} accepted a PASS the property refuses: ${name}`); assert.match(why, want, `${gate} names why: ${name}`); }
    }
    if (want === null) accepted++;
  }
  assert.ok(accepted > 0 && accepted < rows.length, 'the product has rows on both sides of the property');
});

test('the verdict product, carried directly: a run off the head or with a nonzero exit is refused, whatever its output says', () => {
  for (const r of RUNS) {
    const got = judges(verdict([record(r, 'npm test')])), name = JSON.stringify(r);
    const want = r.sha !== 'head' ? /not a command, exit code and output on aaaaaaaa/ : r.exit !== 0 ? new RegExp(`\\(npm test exited ${r.exit}\\)`) : null;
    for (const [gate, why] of Object.entries(got)) {
      if (want === null) assert.equal(why, null, `${gate} refused an honest PASS: ${name}`);
      else { assert.notEqual(why, null, `${gate} accepted a PASS the property refuses: ${name}`); assert.match(why, want, `${gate} names why: ${name}`); }
    }
  }
});

// ---------- recorder: the end-to-end product through the CLI ----------
let repo;
const git = (c, cwd = repo) => execSync(`git ${c}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
// Each run sees no CI variable, so heavy checks are deferred as on a workstation.
const eng = (args, { onSpawn, env = {}, cwd = repo } = {}) => new Promise(resolve => {
  const e = { ...process.env, ...env }; if (!('CI' in env)) delete e.CI;
  const p = spawn(process.execPath, [ENG, ...args], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
  onSpawn?.(p, () => stdout);
  p.on('close', (status, signal) => resolve({ status, signal, stdout, stderr, out: stdout + stderr }));
});
const runLogFile = (root = repo) => path.join(root, '.git', 'eng', 'verdict-runs.jsonl');
const lastRun = (by, root = repo) => !fs.existsSync(runLogFile(root)) ? undefined : fs.readFileSync(runLogFile(root), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.by === by).at(-1);
const pool = async (items, n, f) => { const out = [], q = items.map((x, i) => [x, i]); await Promise.all(Array.from({ length: n }, async () => { while (q.length) { const [x, i] = q.shift(); out[i] = await f(x); } })); return out; };

const repos = [];
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-pass-integrity-repo-'));
  repos.push(dir);
  git('init -q -b main', dir); git('config user.email t@t', dir); git('config user.name t', dir);
  const c = YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
  c.gates.required = []; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.verification.flake_runs = 1;
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  fs.mkdirSync(path.join(dir, '.eng/checks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.eng/checks/light.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.eng/checks/model.sh'), '#!/bin/sh\n# weight: heavy\n# budget: memory=128M workers=1 timeout=30s\nexit 0\n', { mode: 0o755 });
  git('add -A', dir); git('commit -qm base', dir);
  return dir;
}
before(() => { repo = makeRepo(); });
after(() => { for (const d of repos) fs.rmSync(d, { recursive: true, force: true }); });

// CI run 43598304842: one eng run of the pool below ended before it recorded anything, and lastRun's ENOENT failed the test
// with none of eng's output, while the other runs kept going and wrote into the repo after it was removed.
test('the recorder harness: an eng run that ends before it records is reported with its exit and output, not an ENOENT', async () => {
  const dir = makeRepo(), by = 'e2e-ends-before-recording';
  const run = await eng(['run', '--by', by, '--ref', 'no-such-ref', '--', 'true'], { cwd: dir });
  assert.equal(run.status, 1, run.out);
  assert.match(run.stderr, /git worktree add failed/);
  assert.equal(lastRun(by, dir), undefined, 'no record, and no throw');
});

const OUTCOMES = { 'exit 0': 'exit 0', 'exit 1': 'exit 1', 'exit 3': 'exit 3', 'exit 124': 'exit 124', 'SIGKILL (137)': 'kill -KILL $$', 'SIGTERM': 'kill -TERM $$' };
const script = ({ outcome, budget, nested }) => [
  nested === 'deferring gate' ? `${JSON.stringify(process.execPath)} ${JSON.stringify(ENG)} gate checks > /dev/null 2>&1` : null,
  budget === 'timeout stop'
    ? (outcome === 'SIGTERM' ? 'sleep 30 & wait' : `trap ${JSON.stringify(OUTCOMES[outcome])} TERM; echo 'PASS: all green'; sleep 30 & wait`)
    : `echo 'PASS: all green'; ${OUTCOMES[outcome]}`,
].filter(Boolean).join('; ');

test('the recorder product: only a command that exited 0, unstopped, with no nested deferral is recorded as exit 0 and yields PASS', { timeout: 300e3 }, async t => {
  const rows = product({ outcome: Object.keys(OUTCOMES), budget: ['none', 'timeout stop'], nested: ['none', 'deferring gate'] });
  assert.equal(rows.length, 24);
  const runs = await pool(rows, 4, async row => {
    const by = `e2e-${Object.values(row).join('-').replace(/[^a-z0-9]+/gi, '-')}`;
    return { row, by, run: await eng(['run', '--by', by, ...(row.budget === 'timeout stop' ? ['--budget', 'memory=256M workers=1 timeout=3s'] : []), '--', 'sh', '-c', script(row)]) };
  });
  // Read only once every run has ended: a run still appending can leave a partial line.
  for (const { row, by, run, rec } of runs.map(r => ({ ...r, rec: lastRun(r.by) }))) {
    const name = JSON.stringify(row), honest = row.outcome === 'exit 0' && row.budget === 'none' && row.nested === 'none';
    assert.ok(rec, `the run was recorded: ${name} (eng ended with ${run.signal ?? `exit ${run.status}`})\n${run.out}`);
    assert.equal(run.status, rec.exit, `eng run exits with the recorded code: ${name}`);
    if (row.budget === 'timeout stop') assert.match(run.stderr, /stopped by its budget: timeout 3s/, name);
    if (row.nested === 'deferring gate' && row.outcome === 'exit 0' && row.budget === 'none') assert.match(rec.output, /INCOMPLETE \(exit 3\)/, name);
    const v = await eng(['verdict', 'PASS', '--by', by]);
    if (honest) {
      assert.equal(rec.exit, 0, `${name}\n${run.out}`);
      assert.equal(v.status, 0, `the honest run yields PASS: ${v.out}`);
      assert.match(v.stdout, new RegExp(`recorded PASS \\(verification, 1 run\\) by ${by}`));
    } else {
      assert.notEqual(rec.exit, 0, `recorded as a failure, not exit 0: ${name}\n${run.out}`);
      assert.notEqual(v.status, 0, `eng verdict PASS refuses it: ${name}\n${v.out}`);
      assert.match(v.stderr, new RegExp(`exited ${rec.exit} on`), `the refusal names the exit code: ${name}`);
    }
    t.diagnostic(`${name}: recorded exit ${rec.exit}, verdict ${v.status === 0 ? 'PASS' : 'refused'}`);
  }
});

test('the recorder product: eng run itself signalled, while the command traps TERM and exits 0, is not a pass', async () => {
  const by = 'e2e-eng-signalled', ready = 'trap-armed';
  const run = await eng(['run', '--by', by, '--', 'sh', '-c', `trap 'exit 0' TERM; echo ${ready}; sleep 30 & wait`], {
    onSpawn: (p, stdout) => { const iv = setInterval(() => { if (stdout().includes(ready)) { clearInterval(iv); p.kill('SIGTERM'); } }, 20); p.on('close', () => clearInterval(iv)); },
  });
  const rec = lastRun(by);
  assert.equal(rec.exit, 143, run.out);
  assert.equal(run.status, 143);
  const v = await eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(v.status, 0, v.out);
  assert.match(v.stderr, /exited 143 on/);
});

test('a deferred run stops counting only when the same command passes in full; an output claim never stands in', async () => {
  const by = 'e2e-deferred-then-full';
  let r = await eng(['run', '--by', by, '--', process.execPath, ENG, 'gate', 'checks']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /deferred\s+check:model/);
  r = await eng(['run', '--by', by, '--', 'sh', '-c', "echo 'eng gate: PASS (every check ran)'"]);
  assert.equal(r.status, 0, r.out);
  let v = await eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(v.status, 0, 'another command that passed does not hide the deferred one');
  assert.match(v.stderr, /exited 3 on/);
  r = await eng(['run', '--by', by, '--', process.execPath, ENG, 'gate', 'checks'], { env: { CI: 'true' } });
  assert.equal(r.status, 0, `the same command, with CI set, runs the heavy check too: ${r.out}`);
  v = await eng(['verdict', 'PASS', '--by', by]);
  assert.equal(v.status, 0, v.out);
  assert.match(v.stdout, /recorded PASS \(verification, 2 runs\)/);
});

// Recorder dimension: command identity. A failing run stops counting only when the same argv later passes. Two argvs whose
// words join to the same text are different commands (PR 51 verdict 1: removing argument quoting left this file green).
// The expected identity comes from the argv arrays themselves, never from the recorder's own key.
test('the recorder product: a failing run is superseded only by the same argv, never by one whose words join to the same text', async () => {
  const FAIL = ['sh', '-c', 'exit ${E-3}'];   // exits 3; with E=0 the same argv exits 0
  const LATER = { 'same argv': FAIL, 'same joined text': ['sh', '-c', 'exit', '${E-3}'], 'another command': ['true'] };
  for (const [i, [kind, later]] of Object.entries(LATER).entries()) {
    const by = `e2e-identity-${i}`;
    const first = await eng(['run', '--by', by, '--', ...FAIL]);
    assert.equal(first.status, 3, `${kind}: the failing run exits 3\n${first.out}`);
    const second = await eng(['run', '--by', by, '--', ...later], { env: { E: '0' } });
    assert.equal(second.status, 0, `${kind}: the later run passes: ${second.out}`);
    const v = await eng(['verdict', 'PASS', '--by', by]);
    if (JSON.stringify(later) === JSON.stringify(FAIL)) assert.equal(v.status, 0, `${kind}: the same argv passing supersedes the failure: ${v.out}`);
    else { assert.notEqual(v.status, 0, `${kind}: a different argv hid the failing run\n${v.out}`); assert.match(v.stderr, /exited 3 on/, kind); }
  }
});
