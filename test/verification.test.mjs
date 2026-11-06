// Verification tooling decides, not who ran it (Matt, 6 Nov 2026): every gate accepts a verification verdict with runs on its commit,
// and refuses a verdict-free or review-only one on testable code. Review stays the required check for text no check can run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { passProblem, testableFiles, REVIEW_ONLY_DEFAULT, reviewOnlyErrors, runLog, recordRun, runsFor } from '../lib/verification.mjs';
import { selfMergeConfig, decide } from '../lib/self-merge.mjs';
import { gateDecision, autoConfig } from '../lib/merge-queue.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const ROOTCFG = path.resolve(new URL('../eng.config.yml', import.meta.url).pathname);
const AUTOCFG = path.resolve(new URL('../templates/merge-auto/eng.config.yml', import.meta.url).pathname);
const C = selfMergeConfig(YAML.parse(fs.readFileSync(ROOTCFG, 'utf8'))), q = autoConfig(YAML.parse(fs.readFileSync(AUTOCFG, 'utf8')));
const H = 'a'.repeat(40);
const run = (o = {}) => ({ cmd: 'npm test', exit: 0, output: '# pass 12', sha: H, ...o });
const verified = (o = {}) => ({ sha: H, patch_id: 'p1', result: 'PASS', by: 'verifier-1', login: 'Mattslayga', association: 'OWNER', comment_at: '2026-11-03T03:00:00Z', method: 'verification', runs: [run()], ...o });
const reviewed = (o = {}) => verified({ method: 'review', runs: undefined, ...o });

// The same verdicts through both PR gates: self-merge (eng-standard) and eng merge gate (merge.auto repos).
const selfMerge = (verdicts, files, risk = 'low') => {
  const pr = { number: 1, base: 'main', draft: false, sameRepo: true, headSha: H, labels: [risk === 'high' ? 'risk:high' : 'risk:low'] };
  return decide(pr, { risk, containsBase: true, check: { head_sha: H, status: 'completed', conclusion: 'success' }, status: { state: 'success' }, verdicts, files }, C);
};
const mergeGate = (verdicts, files) => gateDecision({ bind: { kind: 'head', sha: H, upToDate: true }, files, verdicts, q });
const gates = [['self-merge', (v, f) => { const d = selfMerge(v, f); return { pass: d.merge, why: d.reason }; }],
  ['eng merge gate', (v, f) => { const d = mergeGate(v, f); return { pass: d.pass, why: d.reasons.join('; ') }; }]];

test('both PR gates accept a verification PASS and refuse a verdict-free or review-only one on testable code', () => {
  for (const [name, g] of gates) {
    assert.equal(g([verified()], ['src/app.ts']).pass, true, `${name}: verification PASS with runs on the head`);
    assert.equal(g([], ['src/app.ts']).pass, false, `${name}: no verdict`);
    const r = g([reviewed()], ['src/app.ts']);
    assert.equal(r.pass, false, `${name}: review-only PASS on code`);
    assert.match(r.why, /review-only PASS on testable code \(src\/app\.ts\)/, name);
  }
});

test('review is the required check for text no check can run, and optional elsewhere', () => {
  for (const [name, g] of gates) {
    assert.equal(g([reviewed()], ['docs/policy.md', 'README.md']).pass, true, `${name}: review PASS on docs and policy text`);
    assert.equal(g([verified()], ['docs/policy.md']).pass, true, `${name}: verification also counts on docs`);
    assert.equal(g([reviewed()], ['docs/policy.md', 'docs/build.sh']).pass, false, `${name}: one script among the docs makes it testable`);
    assert.equal(g([verified(), reviewed({ by: 'reviewer-1' })], ['src/app.ts']).pass, true, `${name}: an extra review on code does not block`);
    assert.equal(g([verified(), reviewed({ by: 'reviewer-1', result: 'FAIL' })], ['src/app.ts']).pass, false, `${name}: a review FAIL still blocks`);
  }
});

test('a verification PASS must carry passing runs on its own commit', () => {
  for (const [name, g] of gates) {
    for (const [v, why] of [[verified({ runs: [] }), /lists no runs/], [verified({ runs: undefined }), /lists no runs/],
      [verified({ runs: [run({ sha: 'b'.repeat(40) })] }), /not a command, exit code and output on aaaaaaaa/],
      [verified({ runs: [run(), run({ cmd: 'npx stryker run', exit: 1 })] }), /failing run \(npx stryker run exited 1\)/],
      [verified({ runs: [{ cmd: 'npm test', exit: 0, sha: H }] }), /not a command, exit code and output/]]) {
      const r = g([v], ['src/app.ts']);
      assert.equal(r.pass, false, `${name}: ${why}`); assert.match(r.why, why, name);
    }
  }
});

test('high-risk changes need N verification PASSes; an optional review does not make up the count', () => {
  const two = [verified(), verified({ by: 'verifier-2' })];
  assert.equal(selfMerge(two, ['bin/eng.mjs'], 'high').merge, true);
  const d = selfMerge([verified(), reviewed({ by: 'reviewer-1' })], ['bin/eng.mjs'], 'high');
  assert.equal(d.merge, false); assert.match(d.reason, /have 1 \(verifier-1\); reviewer-1 does not count: review-only PASS/);
  assert.equal(mergeGate(two, ['bin/eng.mjs']).pass, true);
  assert.equal(mergeGate([verified(), reviewed({ by: 'reviewer-1' })], ['bin/eng.mjs']).need, 'verifiers');
});

test('an unknown file list is testable, and review_only_paths is a list of globs', () => {
  assert.equal(testableFiles(null, REVIEW_ONLY_DEFAULT), null);
  assert.match(passProblem(reviewed(), null), /changed files are unknown/);
  assert.equal(selfMerge([reviewed()], null).merge, false, 'self-merge with an incomplete file list');
  assert.equal(passProblem(verified(), null), null);
  assert.deepEqual(reviewOnlyErrors({ review_only_paths: ['**/*.md'] }), []);
  assert.equal(reviewOnlyErrors({ review_only_paths: 'docs' }).length, 1);
});

// The CLI end to end: eng verdict round records evidence, eng verdict records it, eng verdict check applies the same rule.
let dir;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8' });
const out = r => r.stdout + r.stderr;
before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-verification-'));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(ROOTCFG, path.join(dir, 'eng.config.yml'));
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('eng verdict: the builder verifies its own code with runs on the commit; review is refused on code and accepted on docs', () => {
  git('checkout -qb code');
  fs.mkdirSync(path.join(dir, 'lib')); fs.writeFileSync(path.join(dir, 'lib/sum.mjs'), 'export const sum = (a, b) => a + b;\n');
  git('add -A'); git('commit -qm sum -m "Agent: builder-1"');
  const H = git('rev-parse HEAD');
  assert.match(out(eng('verdict', 'check')), /no verdict for HEAD/, 'verdict-free');

  let r = eng('verdict', 'PASS', '--by', 'builder-1');
  assert.equal(r.status, 1); assert.match(out(r), /no runs by builder-1 on/, 'a PASS with nothing run is refused at record time');

  assert.equal(eng('verdict', 'PASS', '--by', 'reviewer-1', '--review').status, 0);
  r = eng('verdict', 'check');
  assert.equal(r.status, 1, 'review-only on testable code'); assert.match(out(r), /review-only PASS on testable code \(lib\/sum\.mjs\)/);

  r = eng('verdict', 'round', '--by', 'verifier-2', '--', 'sh', '-c', 'echo property sum ok; exit 3');
  assert.equal(r.status, 3);
  assert.match(out(eng('verdict', 'PASS', '--by', 'verifier-2')), /exited 3 on .*record FAIL/, 'a failing run cannot back a PASS');

  r = eng('verdict', 'round', '--by', 'builder-1', '--', process.execPath, '-e', "import('./lib/sum.mjs').then(m => { if (m.sum(2, 3) !== 5) process.exit(1); console.log('sum ok'); })");
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /sum ok/); assert.match(r.stdout, /recorded the run by builder-1/);
  r = eng('verdict', 'PASS', '--by', 'builder-1');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /recorded PASS \(verification, 1 run\) by builder-1/);
  r = eng('verdict', 'check');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /PASS \(PASS verification by builder-1/);
  const note = git(`notes --ref eng-verdict show ${H}`).split('\n').filter(Boolean).map(JSON.parse).at(-1);
  assert.deepEqual([note.method, note.runs.length, note.runs[0].exit, note.runs[0].sha, note.runs[0].output.trim()], ['verification', 1, 0, H, 'sum ok'], 'the note keeps command, exit, output and SHA');

  git('checkout -q main'); git('checkout -qb docs');
  fs.writeFileSync(path.join(dir, 'POLICY.md'), 'Verify before merge.\n'); git('add -A'); git('commit -qm policy -m "Agent: builder-1"');
  assert.equal(eng('verdict', 'PASS', '--by', 'reviewer-1', '--review').status, 0);
  r = eng('verdict', 'check');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /PASS review by reviewer-1/, 'review is the check for policy text');
});

// PR #42 review, finding 2: evidence is every relevant run for the commit and verifier, not a recent window.
test('runsFor keeps a failing command however many other passing runs follow; a re-run of the same command supersedes it', () => {
  const log = path.join(fs.mkdtempSync(path.join(process.env.XDG_CACHE_HOME, 'runs-')), 'runs.jsonl'), r = (cmd, exit, o = {}) => recordRun(log, { sha: H, by: 'v', cmd, exit, output: '', at: '2026-11-06T00:00:00Z', ...o });
  r('npm run e2e', 1);
  for (let i = 0; i < 20; i++) r(`npm test -- shard ${i}`, 0);
  r('npm test -- shard 0', 0, { by: 'other' }); r('npm run e2e', 0, { sha: 'b'.repeat(40) });
  const runs = runsFor(log, H, 'v');
  assert.equal(runs.length, 21, 'every distinct command this verifier ran on this commit');
  assert.deepEqual(runs.filter(x => x.exit !== 0).map(x => x.cmd), ['npm run e2e'], 'the old failure is still there');
  assert.match(passProblem({ sha: H, method: 'verification', result: 'PASS', runs }, ['src/a.ts']), /failing run \(npm run e2e exited 1\)/);
  r('npm run e2e', 0);
  const again = runsFor(log, H, 'v');
  assert.deepEqual([again.length, again.filter(x => x.cmd === 'npm run e2e').map(x => x.exit)], [21, [0]], 'a later pass of the same command supersedes its failure');
  assert.equal(passProblem({ sha: H, method: 'verification', result: 'PASS', runs: again }, ['src/a.ts']), null);
});

test('eng verdict PASS is refused after 1 failing round and 20 passing rounds of other commands on the same commit', () => {
  git('checkout -q main'); git('checkout -qb aged');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.writeFileSync(path.join(dir, 'lib/aged.mjs'), 'export const aged = 1;\n'); git('add -A'); git('commit -qm aged -m "Agent: builder-1"');
  const sha = git('rev-parse HEAD');
  assert.equal(eng('verdict', 'round', '--by', 'builder-1', '--', 'sh', '-c', 'echo e2e broke; exit 1').status, 1);
  const log = runLog(git('rev-parse --path-format=absolute --git-common-dir'));
  for (let i = 0; i < 20; i++) recordRun(log, { sha, by: 'builder-1', cmd: `true ${i}`, exit: 0, output: 'ok', at: new Date().toISOString() });
  const r = eng('verdict', 'PASS', '--by', 'builder-1');
  assert.equal(r.status, 1, out(r)); assert.match(out(r), /run `sh -c echo e2e broke; exit 1` by builder-1 exited 1/);
});

// PR #42 review, finding 1: a PASS counts only for the exact commit it ran on. Patch-id ignores the message and whitespace.
test('eng verdict check does not carry a PASS to a new SHA with the same patch-id (message-only amend, whitespace-only change)', () => {
  git('checkout -q main'); git('checkout -qb carry');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.writeFileSync(path.join(dir, 'lib/carry.mjs'), 'export const carry = 1;\n'); git('add -A'); git('commit -qm carry -m "Agent: builder-1"');
  assert.equal(eng('verdict', 'round', '--by', 'builder-1', '--', 'true').status, 0);
  assert.equal(eng('verdict', 'PASS', '--by', 'builder-1').status, 0);
  const tested = git('rev-parse HEAD');
  assert.equal(eng('verdict', 'check').status, 0, 'the tested commit passes');
  git('commit -q --amend -m "carry (reworded)" -m "Agent: builder-1"');
  let r = eng('verdict', 'check');
  assert.equal(r.status, 1, `message-only amend must not carry the PASS: ${out(r)}`);
  assert.match(out(r), new RegExp(`PASS by builder-1 is for ${tested.slice(0, 8)}, not HEAD`));
  fs.writeFileSync(path.join(dir, 'lib/carry.mjs'), 'export const carry = 1;   \n'); git('commit -qam "trailing spaces"');
  r = eng('verdict', 'check');
  assert.equal(r.status, 1, `whitespace-only change must not carry the PASS: ${out(r)}`);
});

