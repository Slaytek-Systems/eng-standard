// A pull request's gate runs less (issue #60 and the covers-based selection, 10 Nov 2026): eng gate --event pr runs each
// check verification.flake_runs_pr times and, with verification.pr_checks: affected, only the checks the change reaches.
// Main runs every check flake_runs times. verification.parallel caps how many run at once; `# serial:` runs one alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { checkSpec, cores } from '../lib/budget.mjs';
import { affectedBy, checkErrors, flakeRunsOf, parallelOf } from '../lib/verification.mjs';
import { agentsBlock as agentsMd, shippingMd } from '../lib/render.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.join(path.dirname(path.dirname(ENG)), 'templates/eng.config.yml');
const out = r => r.stdout + r.stderr;
const SMALL = '# budget: memory=64M workers=1 timeout=30s';

let dir;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const eng = (args, env = {}) => { const e = { ...process.env }; for (const k of ['CI', 'GITHUB_BASE_REF', 'BUILDKITE_PULL_REQUEST_BASE_BRANCH', 'ENG_BASE']) delete e[k]; Object.assign(e, { ENG_BUDGET_FREE_MB: '1000' }, env); return spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: e }); };
const config = v => { const c = YAML.parse(fs.readFileSync(TPL, 'utf8')); c.gates.required = []; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.verification = { checks_dir: '.eng/checks', flake_runs: 3, ...v }; return c; };
const write = (f, text, mode) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text, mode ? { mode } : undefined); };
// Each check appends its id to .git/ran once per run, so the test reads how often each one ran.
const counting = (id, covers, exit = 0) => `#!/bin/sh\n${covers === null ? '' : `# covers: ${covers}\n`}${SMALL}\necho ${id} >> "$(git rev-parse --git-dir)/ran"\nexit ${exit}\n`;
const ran = () => { const f = path.join(dir, '.git/ran'), l = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : []; fs.rmSync(f, { force: true }); return Object.fromEntries([...new Set(l)].sort().map(id => [id, l.filter(x => x === id).length])); };
const branch = (name, files) => { git('checkout -q main'); git(`checkout -qB ${name}`); for (const [f, t] of Object.entries(files)) t === null ? fs.rmSync(path.join(dir, f)) : write(f, t); git('add -A'); git(`commit -qm ${name} --allow-empty`); };

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-select-'));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  write('eng.config.yml', YAML.stringify(config({ flake_runs_pr: 1, pr_checks: 'affected' })));
  write('src/a/one.js', '1\n'); write('src/b/two.js', '2\n'); write('docs/x.md', 'x\n');
  write('.eng/checks/a.sh', counting('a', 'src/a'), 0o755);
  write('.eng/checks/b.sh', counting('b', 'src/b/two.js', 1), 0o755);
  write('.eng/checks/c.sh', counting('c', null), 0o755);
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('flake_runs_pr: --event pr runs each check that many times; no --event and --event main keep flake_runs', () => {
  branch('docs-only', { 'src/a/one.js': '1b\n' });
  let r = eng(['gate', 'checks', '--event', 'pr']);
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(ran(), { a: 1, c: 1 });
  assert.match(r.stdout, /checks: 2 of 3, those whose # covers: paths changed against main .*; each runs 1 time \(verification\.flake_runs_pr, --event pr\)/);
  for (const args of [['gate', 'checks'], ['gate', 'checks', '--event', 'main']]) {
    r = eng(args);
    assert.equal(r.status, 1, `${args.join(' ')} runs b, which fails: ${out(r)}`);
    assert.deepEqual(ran(), { a: 3, b: 3, c: 3 }, args.join(' '));
    assert.match(r.stdout, /each runs 3 times \(verification\.flake_runs\)/);
  }
  r = eng(['gate', 'checks', '--event', 'push']);
  assert.equal(r.status, 1); assert.match(r.stderr, /--event must be pr or main \(got push\)/);
  assert.deepEqual(ran(), {}, 'a bad --event runs nothing');
});

test('flake_runs_pr is a whole number from 1 to flake_runs; parallel and pr_checks are checked too', () => {
  assert.deepEqual(checkErrors({ flake_runs: 3, flake_runs_pr: 1 }), []);
  assert.deepEqual(checkErrors({ flake_runs: 3, flake_runs_pr: 3, parallel: 4, pr_checks: 'all' }), []);
  for (const bad of [0, 4, 1.5, '1']) assert.match(checkErrors({ flake_runs: 3, flake_runs_pr: bad }).join(), /flake_runs_pr must be an integer from 1 to verification\.flake_runs \(3\)/, String(bad));
  assert.match(checkErrors({ flake_runs_pr: 2 }).join(), /from 1 to verification\.flake_runs \(1\)/, 'flake_runs defaults to 1, so flake_runs_pr cannot raise it');
  for (const bad of [0, 'yes', 2.5]) assert.match(checkErrors({ parallel: bad }).join(), /verification\.parallel must be true, false or a whole number >= 1/, String(bad));
  assert.match(checkErrors({ pr_checks: 'some' }).join(), /verification\.pr_checks must be all or affected/);
  assert.equal(flakeRunsOf({ verification: { flake_runs: 3, flake_runs_pr: 1 } }, 'pr'), 1);
  assert.equal(flakeRunsOf({ verification: { flake_runs: 3, flake_runs_pr: 1 } }, 'main'), 3);
  assert.equal(flakeRunsOf({ verification: { flake_runs: 3 } }, 'pr'), 3, 'flake_runs_pr defaults to flake_runs');
  assert.deepEqual([undefined, false, true, 2].map(p => parallelOf({ verification: { parallel: p } })), [1, 1, 4, 2]);
  const c = config({ flake_runs_pr: 5 });
  write('eng.config.yml', YAML.stringify(c));
  try { const r = eng(['gate', 'checks', '--event', 'pr']); assert.equal(r.status, 1); assert.match(out(r), /flake_runs_pr must be an integer from 1/); }
  finally { git('checkout -q -- eng.config.yml'); }
});

test('pr_checks: affected runs a check when the PR changed a covered path; an unaffected failing check passes the PR and fails main', () => {
  branch('touch-a', { 'src/a/new.js': 'n\n', 'docs/x.md': 'y\n' });
  let r = eng(['gate', 'checks', '--event', 'pr']);
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(ran(), { a: 1, c: 1 }, 'a covers src/a; c has no # covers: line, so it always runs');
  assert.match(r.stdout, /unaffected\s+check:b\s+not run on this pull request: it covers none of the 2 changed paths \(verification\.pr_checks: affected\); main runs it/);
  assert.match(r.stdout, /eng gate: PASS/);
  r = eng(['gate', 'checks', '--event', 'main']);
  assert.equal(r.status, 1, 'the same commit fails on main, which runs b'); assert.deepEqual(ran(), { a: 3, b: 3, c: 3 });
  r = eng(['gate', 'check:b', '--event', 'pr']);
  assert.equal(r.status, 1, 'a check named on the command line runs whatever the PR touched');
  assert.deepEqual(ran(), { b: 1 });
  branch('touch-b', { 'src/b/two.js': '2b\n' });
  r = eng(['gate', 'checks', '--event', 'pr']);
  assert.equal(r.status, 1, out(r)); assert.deepEqual(ran(), { b: 1, c: 1 }, 'b covers the file itself');
  branch('move-out-of-a', {}); git('mv src/a/one.js docs/one.js'); git('commit -qm move');
  r = eng(['gate', 'checks', '--event', 'pr']);
  assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { a: 1, c: 1 }, 'a rename counts its old path, so moving a file out of src/a runs a');
  write('src/a/one.js', 'uncommitted\n');
  try { assert.deepEqual((eng(['gate', 'checks', '--event', 'pr']), ran()), { a: 1, c: 1 }, 'uncommitted changes count'); }
  finally { fs.rmSync(path.join(dir, 'src/a/one.js')); }
});

test('pr_checks: affected fails closed: eng config, the checks dir, an unknown diff and pr_checks: all run every check', () => {
  const all = { a: 1, b: 1, c: 1 };
  branch('config', { 'eng.config.yml': YAML.stringify(config({ flake_runs_pr: 1, pr_checks: 'affected', review_only_paths: ['**/*.md'] })) });
  let r = eng(['gate', 'checks', '--event', 'pr']);
  assert.equal(r.status, 1); assert.deepEqual(ran(), all); assert.match(r.stdout, /checks: all 3, because eng\.config\.yml changed/);
  branch('lock', { '.eng/lock.json': '{}\n' });
  r = eng(['gate', 'checks', '--event', 'pr']); assert.deepEqual(ran(), all); assert.match(r.stdout, /because \.eng\/lock\.json changed/);
  branch('check-edit', { '.eng/checks/c.sh': counting('c', null).replace('exit 0', 'true\nexit 0') });
  r = eng(['gate', 'checks', '--event', 'pr']); assert.deepEqual(ran(), all); assert.match(r.stdout, /because \.eng\/checks\/c\.sh changed/);
  branch('unknown-base', { 'src/a/one.js': 'u\n' });
  r = eng(['gate', 'checks', '--event', 'pr', '--base', 'no-such-ref']);
  assert.deepEqual(ran(), all); assert.match(r.stdout, /because the diff against no-such-ref cannot be computed/);
  r = eng(['gate', 'checks', '--event', 'pr'], { GITHUB_BASE_REF: 'gone' });
  assert.deepEqual(ran(), all, 'a CI base branch that is not fetched runs every check'); assert.match(r.stdout, /diff against origin\/gone cannot be computed/);
  git('checkout -q main');
  r = eng(['gate', 'checks', '--event', 'pr']); assert.deepEqual(ran(), all); assert.match(r.stdout, /because the diff against the merge base is empty/);
  write('eng.config.yml', YAML.stringify(config({ flake_runs_pr: 1 }))); git('commit -qam all-checks');
  branch('pr-checks-all', { 'src/a/one.js': 'v\n' });
  r = eng(['gate', 'checks', '--event', 'pr']); assert.deepEqual(ran(), all); assert.match(r.stdout, /checks: all 3 \(verification\.pr_checks: all\)/);
  git('checkout -q main'); git('reset -q --hard HEAD~1');
});

test('affectedBy matches a covered file, a path under a covered dir, and nothing that only shares a prefix', () => {
  const runs = (covers, files) => affectedBy(files, '.eng/checks').runs({ covers });
  assert.equal(runs(['src/a'], ['src/a/x.js']), true);
  assert.equal(runs(['src/a/'], ['src/a/x.js']), true, 'a trailing slash still names the folder');
  assert.equal(runs(['./src/a'], ['src/a/x.js']), true);
  assert.equal(runs(['src/a'], ['src/ab/x.js']), false, 'src/ab is not under src/a');
  assert.equal(runs(['src/a.js'], ['src/a.js']), true);
  assert.equal(runs([], ['anything']), true, 'no # covers: line: always runs');
  assert.deepEqual(affectedBy(null, '.eng/checks'), { all: 'the diff against the merge base is unknown' });
  assert.deepEqual(affectedBy(['custom/checks/x.sh'], 'custom/checks/'), { all: 'custom/checks/x.sh changed' });
});

const timed = (id, extra = '') => `#!/usr/bin/env bash\n${SMALL}\n${extra}echo "${id} start $(date +%s%N)" >> "$TIMES"; sleep 0.6; echo "${id} end $(date +%s%N)" >> "$TIMES"\n`;
const spans = file => { const l = fs.readFileSync(file, 'utf8').trim().split('\n').map(x => x.split(' ')), ids = [...new Set(l.map(x => x[0]))]; return Object.fromEntries(ids.map(id => [id, [Number(l.find(x => x[0] === id && x[1] === 'start')[2]), Number(l.find(x => x[0] === id && x[1] === 'end')[2])]])); };
const most = s => Math.max(...Object.values(s).map(([t]) => Object.values(s).filter(([a, b]) => a <= t && t < b).length));

test('verification.parallel caps how many checks run at once, and a # serial: check runs alone', { skip: cores() < 3 && 'needs 3 cores so the cap, not the cores, limits the run' }, () => {
  git('checkout -q main'); git('checkout -qB parallel');
  const times = path.join(dir, '.git/times');
  fs.rmSync(path.join(dir, '.eng/checks'), { recursive: true });
  for (const id of ['p1', 'p2', 'p3', 'p4']) write(`.eng/checks/${id}.sh`, timed(id), 0o755);
  write('eng.config.yml', YAML.stringify(config({ parallel: 2 }))); git('add -A'); git('commit -qm parallel');
  let r = eng(['gate', 'checks'], { TIMES: times });
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /up to 2 side by side while the budgets fit \(verification\.parallel\)/);
  let s = spans(times); fs.rmSync(times);
  assert.equal(most(s), 2, `parallel: 2 runs two at a time, never more: ${JSON.stringify(s)}`);
  write('.eng/checks/p2.sh', timed('p2', '# serial: binds port 5432\n'), 0o755);
  write('eng.config.yml', YAML.stringify(config({ parallel: true }))); git('add -A'); git('commit -qm serial');
  r = eng(['gate', 'checks'], { TIMES: times });
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /wait\s+check:p2: it runs alone \(# serial: binds port 5432\)/);
  s = spans(times); fs.rmSync(times);
  for (const id of ['p1', 'p3', 'p4']) assert.ok(s[id][1] <= s.p2[0] || s[id][0] >= s.p2[1], `${id} never overlaps the serial p2: ${JSON.stringify(s)}`);
  assert.ok(s.p4[0] < s.p3[1], `the checks after it still run side by side: ${JSON.stringify(s)}`);
  git('checkout -q main'); git('branch -qD parallel');
});

test('# serial: needs a reason', () => {
  assert.equal(checkSpec(`#!/bin/sh\n# serial: fixed port 8080\n`).serial, 'fixed port 8080');
  assert.match(checkSpec('#!/bin/sh\n# serial:\n').error, /# serial: must say why/);
  assert.equal('serial' in checkSpec('#!/bin/sh\n'), false);
});

test('SHIPPING.md and AGENTS.md describe the PR gate and the cap only when the repo sets them', () => {
  const plain = config({}), set = config({ flake_runs_pr: 1, pr_checks: 'affected', parallel: 3 });
  const cwd = process.cwd(); process.chdir(dir);
  try {
    assert.doesNotMatch(shippingMd(plain), /--event pr/);
    assert.match(agentsMd(plain), /Checks run one after another; with `verification\.parallel: true`, side by side/);
    const sh = shippingMd(set);
    assert.match(sh, /Pull requests \(`eng gate --event pr`\) run only the checks whose `# covers:` paths changed against the merge base, 1 time each \(`flake_runs_pr`\)\. A check with no `# covers:` line runs on every pull request, and a change to `eng\.config\.yml`, `\.eng\/lock\.json`, `\.eng\/checks` or a diff eng cannot compute runs every check\. Main \(`eng gate --event main`, or no `--event`\) runs every check 3 times after every merge/);
    assert.match(shippingMd(config({ flake_runs_pr: 1 })), /Pull requests \(`eng gate --event pr`\) run every check, 1 time each/);
    assert.match(agentsMd(set), /Checks run side by side, at most 3 at once \(`verification\.parallel`\).*declares `# serial: <why>`/);
  } finally { process.chdir(cwd); }
});
