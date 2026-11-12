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
import { shippingMd } from '../lib/render.mjs';
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
  assert.match(r.stdout, /checks: 2 of 3, those whose # covers: paths changed against main, and c \(no # covers: line\) \(verification\.pr_checks: affected\); each runs 1 time \(verification\.flake_runs_pr, --event pr\)/);
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

test('SHIPPING.md describes the PR gate and the cap only when the repo sets them', () => {
  const plain = config({}), set = config({ flake_runs_pr: 1, pr_checks: 'affected', parallel: 3 });
  const cwd = process.cwd(); process.chdir(dir);
  try {
    assert.doesNotMatch(shippingMd(plain), /--event pr/);
    assert.match(shippingMd(plain), /Checks run one after another; with `verification\.parallel: true`, side by side/);
    const sh = shippingMd(set);
    assert.match(sh, /Pull requests \(`eng gate --event pr`\) run only the checks whose `# covers:` paths changed against the merge base, 1 time each \(`flake_runs_pr`\)\. A check with no `# covers:` line runs on every pull request, and a change to `eng\.config\.yml`, `\.eng\/lock\.json`, `\.eng\/checks` or a diff eng cannot compute runs every check\. `# covers:` must name every path the check reads, its own helper scripts and fixtures included: a changed path it does not name skips the check\. Symlinks are not followed: a pull request that adds, removes or changes a symlink anywhere runs every check, a symlinked check or checks folder runs every check, and a check whose covered path is, holds or goes through a symlink \(an ignored one included\) runs on every pull request\. A covers path that is not canonical \(a `\.` or `\.\.` segment, `\/\/`, a leading or trailing `\/` or a backslash\) runs its check on every pull request, and a changed path that is not canonical runs every check\. Covers paths are split on whitespace, so none can contain a space, and globs are not expanded \(name files or folders\)\. Only the pull request's target as the base selects checks: any other `--base` or `ENG_BASE`, such as a parent PR's branch named locally, runs every check\. A stacked PR selects in CI, where its target is the parent branch\. Main \(`eng gate --event main`, or no `--event`\) runs every check 3 times after every merge/);
    assert.match(shippingMd(config({ flake_runs_pr: 1 })), /Pull requests \(`eng gate --event pr`\) run every check, 1 time each/);
    assert.match(shippingMd(set), /Checks run side by side, at most 3 at once \(`verification\.parallel`\).*declares `# serial: <why>`/);
  } finally { process.chdir(cwd); }
});

// Fix round 1 (both round-1 verifiers on d96203f): a PR must never skip a check its change affects.
// Each test builds its own repo with `main` and one branch, then reads which checks ran.
async function inRepo(checks, files, fn) {
  const saved = dir; dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-select-fix-'));
  try {
    git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
    write('eng.config.yml', YAML.stringify(config({ flake_runs_pr: 1, pr_checks: 'affected' })));
    for (const [f, t] of Object.entries(files)) write(f, t);
    for (const [id, text] of Object.entries(checks)) write(`.eng/checks/${id}.sh`, text, 0o755);
    git('add -A'); git('commit -qm base'); git('checkout -qb pr');
    await fn();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); dir = saved; }
}
const gatePr = (...more) => eng(['gate', 'checks', '--event', 'pr', ...more]);

test('false skip: a non-ASCII or special filename, or an untracked or unstaged one, still selects the check that covers it', async () => {
  const names = ['src/é.js', 'src/tab\tname.js', 'src/space name.js', 'src/ünï/file.js'];
  await inRepo({ s: counting('s', 'src'), o: counting('o', 'other') }, { 'src/a': '1\n', 'other/x': '1\n', ...Object.fromEntries(names.map(n => [n, '1\n'])) }, () => {
    for (const n of names) {
      write(n, '2\n'); git('add -A'); git('commit -qm change');
      const r = gatePr(); assert.equal(r.status, 0, out(r));
      assert.deepEqual(ran(), { s: 1 }, `committed change to ${JSON.stringify(n)} runs the check covering src`);
      git('checkout -q main'); git('checkout -q -B pr');
    }
    write('src/space name.js', 'unstaged\n'); // untracked-with-space is covered by the loop above; here an unstaged edit of a tracked file
    git('checkout -q main'); write('src/a', 'dirty\n');
    assert.equal(gatePr().status, 0); assert.deepEqual(ran(), { s: 1 }, 'an unstaged edit of tracked src/a (porcelain " M src/a") runs it');
    git('checkout -q -- .'); write('src/new file.js', 'n\n');
    assert.equal(gatePr().status, 0); assert.deepEqual(ran(), { s: 1 }, 'an untracked name with a space runs it');
  });
});

test('false skip: every # covers: line counts, not just the first', async () => {
  await inRepo({ a: counting('a', 'src/a').replace('# covers: src/a\n', '# covers: src/a\n# covers: src/b\n') }, { 'src/a/1': '1\n', 'src/b/2': '2\n', 'docs/x': 'x\n' }, () => {
    write('src/b/2', 'changed\n'); git('commit -qam b');
    const r = gatePr(); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { a: 1 }, 'a change under the second covers: line runs the check');
  });
});

test('false skip: a covers path with .. always runs its check (round 6), and one that leaves the repo is a config error', async () => {
  await inRepo({ a: counting('a', 'other/../src'), z: counting('z', '../outside') }, { 'src/a': '1\n', 'other/x': '1\n' }, () => {
    write('src/a', '2\n'); git('commit -qam a');
    const r = gatePr();
    assert.equal(r.status, 1, 'the out-of-repo check fails the gate');
    assert.match(out(r), /check z: "# covers:" .* outside the repo \(\.\.\/outside\)/);
    assert.deepEqual(ran(), { a: 1 }, 'other/../src is not canonical, so a runs');
  });
});

test('false skip: a --base that is not the PR target runs every check, and says why', async () => {
  await inRepo({ s: counting('s', 'src'), o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n' }, () => {
    git('checkout -q -b sibling main'); write('docs', 'd\n'); git('add -A'); git('commit -qm sibling'); git('checkout -q pr');
    write('src/a', '2\n'); git('commit -qam src');
    write('other/b', '2\n'); git('commit -qam other');
    let r = gatePr('--base', 'sibling');
    assert.deepEqual(ran(), { s: 1, o: 1 }, out(r));
    assert.match(r.stdout, /checks: all 2, because the base sibling is not the pull request's target main; selection needs the PR target/);
    assert.doesNotMatch(r.stdout, /cannot be computed/, 'the diff can be computed; the base is what is refused');
    r = gatePr('--base', 'main'); assert.deepEqual(ran(), { s: 1, o: 1 }, 'the real target gives the real diff: both changed');
    git('checkout -q HEAD~1'); r = gatePr('--base', 'main'); assert.deepEqual(ran(), { s: 1 }, 'a correct --base still selects');
  });
});

// Fix round 2 (both round-2 verifiers on b46d8a2): no-keys repos gate as in 0.21.1; checks_dir is normalised.
// Fix round 3 (both round-3 verifiers on 9d6cd09): no local base can be proven to be a stacked PR's fork point, so under
// pr_checks: affected only a base equal to the PR target selects; and with none of the new keys # covers: reads as in 0.21.1.
const breaks = (id, covers) => counting(id, covers).replace('exit 0', `grep -q broken src/a && exit 1; exit 0`);
test('false skip: --base or ENG_BASE naming the PR\'s own commit, own branch, HEAD or a parent PR branch runs every check', async () => {
  await inRepo({ s: breaks('s', 'src'), o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n', 'docs/x': 'x\n' }, () => {
    git('checkout -q -b parent'); write('other/b', '2\n'); git('commit -qam parent');
    git('checkout -q -b child'); write('src/a', 'broken\n'); git('commit -qam hiding'); const own = git('rev-parse HEAD');
    write('docs/x', 'y\n'); git('commit -qam docs');
    for (const dirty of [false, true]) {
      if (dirty) write('scratch.txt', 'one dirty path\n');
      for (const [label, run] of [[`--base ${own}`, () => gatePr('--base', own)], ['--base child', () => gatePr('--base', 'child')], ['--base HEAD', () => gatePr('--base', 'HEAD')],
        ['--base parent', () => gatePr('--base', 'parent')], [`ENG_BASE=${own}`, () => eng(['gate', 'checks', '--event', 'pr'], { ENG_BASE: own })]]) {
        const r = run();
        assert.equal(r.status, 1, `${label}${dirty ? ' + dirty' : ''}: the broken src check must run and fail: ${out(r)}`);
        assert.deepEqual(ran(), { o: 1, s: 1 }, label);
        assert.match(r.stdout, /checks: all 2, because the base \S+ is not the pull request's target main; selection needs the PR target/, label);
      }
    }
  });
});

test('--base=<ref> is accepted like --base <ref>', async () => {
  await inRepo({ s: counting('s', 'src'), o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n' }, () => {
    git('checkout -q -b sibling main'); write('docs', 'd\n'); git('add -A'); git('commit -qm sibling'); git('checkout -q pr');
    write('src/a', '2\n'); git('commit -qam src');
    let r = gatePr('--base=sibling'); assert.deepEqual(ran(), { o: 1, s: 1 }, out(r));
    assert.match(r.stdout, /because the base sibling is not the pull request's target main/);
    r = gatePr('--base=main'); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { s: 1 }, 'the target selects');
  });
});

test('no new keys: # covers: reads the first line as written, as in 0.21.1 (outside path, stale second line)', async () => {
  await inRepo({}, { 'src/a': '1\n' }, () => {
    const shared = `${path.basename(dir)}.shared`, outside = path.join(dir, '..', shared);
    fs.writeFileSync(outside, 's\n');
    try {
      write('.eng/checks/x.sh', counting('x', `../${shared}`), 0o755);
      write('.eng/checks/y.sh', counting('y', 'src').replace('# covers: src\n', '# covers: src\n# covers: absent-second-header\n'), 0o755);
      write('eng.config.yml', YAML.stringify(config({})));
      let r = eng(['gate', 'checks']); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { x: 3, y: 3 });
      r = gatePr(); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { x: 3, y: 3 }, '--event pr without the keys too');
      write('eng.config.yml', YAML.stringify(config({ flake_runs_pr: 1, pr_checks: 'affected' })));
      r = gatePr(); assert.equal(r.status, 1, out(r));
      assert.match(r.stdout, /check x: "# covers:" .* outside the repo/); assert.match(r.stdout, /check y is stale: covers missing path\(s\) absent-second-header/);
    } finally { fs.rmSync(outside, { force: true }); }
  });
});

test('no new keys: a stacked --base or ENG_BASE gives the v0.21.1 e2e decision (docs-only child of a source-changing parent)', async () => {
  await inRepo({}, { 'src/a.js': '1\n', 'docs/x.md': 'x\n' }, () => {
    const c = config({}); c.gates.required = ['e2e']; write('eng.config.yml', YAML.stringify(c)); git('checkout -q main'); git('add -A'); git('commit -qm no-keys');
    git('checkout -q -B parent'); write('src/a.js', '2\n'); git('commit -qam parent');
    git('checkout -q -b child'); write('docs/x.md', 'y\n'); git('commit -qam child');
    let r = eng(['e2e', '--required', '--json', '--event', 'pr', '--base', 'parent']);
    assert.equal(JSON.parse(r.stdout).required, false, out(r));
    r = eng(['e2e', '--required', '--event', 'pr'], { ENG_BASE: 'parent' });
    assert.match(r.stdout, /eng e2e --required: NOT REQUIRED \(only docs/, out(r));
    r = eng(['gate', 'e2e'], { ENG_BASE: 'parent' });
    assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng gate: PASS/);
    r = eng(['e2e', '--required', '--json', '--event', 'pr']);
    assert.equal(JSON.parse(r.stdout).required, true, 'against main the parent\'s src change still requires e2e');
  });
});

test('checks_dir is normalised like the filesystem path, so a changed check always runs every check', async () => {
  for (const d of ['.eng//checks', 'other/../.eng/checks', './.eng/checks/']) {
    await inRepo({ a: counting('a', 'src') }, { 'src/x': '1\n', 'other/y': '1\n' }, () => {
      git('checkout -q main'); write('eng.config.yml', YAML.stringify(config({ flake_runs_pr: 1, pr_checks: 'affected', checks_dir: d }))); git('commit -qam dir'); git('checkout -q -B pr');
      write('.eng/checks/a.sh', counting('a', 'src', 9)); git('commit -qam failing-check');
      const r = gatePr();
      assert.equal(r.status, 1, `checks_dir ${d}: a changed failing check must run: ${out(r)}`);
      assert.deepEqual(ran(), { a: 1 }, d); assert.match(r.stdout, /because \.eng\/checks\/a\.sh changed/, d);
    });
  }
  assert.deepEqual(affectedBy(['.eng/checks/a.sh'], '.eng//checks'), { all: '.eng/checks/a.sh changed' });
  assert.match(checkErrors({ pr_checks: 'affected', checks_dir: '../checks' }).join(), /verification\.checks_dir \(\.\.\/checks\) leaves the repo/);
  assert.deepEqual(checkErrors({ checks_dir: '../checks' }), [], 'without pr_checks: affected, checks_dir validates as in 0.21.1');
});

test('a glob in # covers: says globs are unsupported under pr_checks: affected; without it the 0.21.1 stale message stays', async () => {
  await inRepo({ g: counting('g', 'src/*.js') }, { 'src/a.js': '1\n' }, () => {
    let r = gatePr();
    assert.equal(r.status, 1); assert.match(r.stdout, /check g: "# covers:" in \.eng\/checks\/g\.sh names glob\(s\) src\/\*\.js; globs are unsupported/, out(r));
    assert.doesNotMatch(r.stdout, /stale/);
    write('eng.config.yml', YAML.stringify(config({})));
    r = eng(['gate', 'checks']); assert.equal(r.status, 1); assert.match(r.stdout, /check g is stale: covers missing path\(s\) src\/\*\.js/);
  });
});

test('SHIPPING.md states the no-spaces and no-globs limit only under pr_checks: affected', () => {
  const cwd = process.cwd(); process.chdir(dir);
  try {
    assert.match(shippingMd(config({ pr_checks: 'affected' })), /Covers paths are split on whitespace, so none can contain a space, and globs are not expanded/);
    for (const v of [{}, { flake_runs_pr: 1 }]) assert.doesNotMatch(shippingMd(config(v)), /split on whitespace/);
  } finally { process.chdir(cwd); }
});

test('--event=pr is accepted like --event pr, and a repo with none of the new keys prints no checks: line', async () => {
  await inRepo({ s: counting('s', 'src') }, { 'src/a': '1\n' }, () => {
    write('src/a', '2\n'); git('commit -qam a');
    let r = eng(['gate', 'checks', '--event=pr']); assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /checks: 1 of 1/);
    r = eng(['gate', 'checks', '--event=bogus']); assert.equal(r.status, 1); assert.match(r.stderr, /--event must be pr or main \(got bogus\)/);
    write('eng.config.yml', YAML.stringify(config({}))); r = gatePr();
    assert.equal(r.status, 0, out(r)); assert.doesNotMatch(r.stdout, /^\s+checks: /m);
  });
});

test('false skip: the rendered guidance says # covers: must name the check\'s helpers and fixtures', () => {
  const sh = shippingMd(config({ flake_runs_pr: 1, pr_checks: 'affected' }));
  assert.match(sh, /`# covers:` must name every path the check reads, its own helper scripts and fixtures included/);
  assert.match(fs.readFileSync(TPL, 'utf8'), /'# covers:' must name every path the check reads, its helper scripts and fixtures too/);
  assert.match(fs.readFileSync(TPL, 'utf8'), /none can contain a space, and globs are not expanded/, 'the template states the no-glob rule');
});

// Fix round 4 (both round-4 verifiers on ed87514): git names a symlink, never its target, so selection resolves the checks
// dir, each check file and each covered path to its real paths. A change only to a target still runs the check.
const link = (target, at) => { fs.mkdirSync(path.dirname(path.join(dir, at)), { recursive: true }); fs.symlinkSync(target, path.join(dir, at)); };
const onMain = setup => { git('checkout -q main'); setup(); git('add -A'); git('commit -qm links'); git('checkout -q -B pr'); };
const failsAndRan = (r, ids, label) => { assert.equal(r.status, 1, `${label}: the check must run and fail: ${out(r)}`); assert.deepEqual(ran(), ids, `${label}: ${out(r)}`); };

test('symlinks: a symlinked check file whose target alone changed runs every check and fails', async () => {
  await inRepo({ o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n', 'scripts/a.sh': counting('a', 'src') }, () => {
    onMain(() => { fs.chmodSync(path.join(dir, 'scripts/a.sh'), 0o755); link('../../scripts/a.sh', '.eng/checks/a.sh'); });
    write('scripts/a.sh', counting('a', 'src', 1)); git('commit -qam target');
    const r = gatePr(); failsAndRan(r, { a: 1, o: 1 }, 'symlinked check');
    assert.match(r.stdout, /checks: all 2, because verification\.checks_dir \.eng\/checks is, holds or goes through a symlink/);
  });
});

test('symlinks: a symlinked checks dir whose target alone changed runs every check and fails', async () => {
  await inRepo({}, { 'src/a': '1\n', 'other/b': '1\n', 'scripts/a.sh': counting('a', 'src'), 'scripts/o.sh': counting('o', 'other') }, () => {
    onMain(() => { for (const f of ['a', 'o']) fs.chmodSync(path.join(dir, `scripts/${f}.sh`), 0o755); link('../scripts', '.eng/checks'); });
    write('scripts/a.sh', counting('a', 'src', 1)); git('commit -qam target');
    failsAndRan(gatePr(), { a: 1, o: 1 }, 'symlinked checks dir');
  });
});

test('symlinks: a symlinked folder on the way to a covered path or the checks dir still selects', async () => {
  const reads = (id, p) => counting(id, p).replace('exit 0', `grep -q broken ${p} && exit 1; exit 0`);
  await inRepo({ k: reads('k', 'lib/a.js'), o: counting('o', 'other') }, { 'src/a.js': '1\n', 'other/b': '1\n' }, () => {
    onMain(() => link('src', 'lib'));
    write('src/a.js', 'broken\n'); git('commit -qam target');
    failsAndRan(gatePr(), { k: 1 }, 'covers lib/a.js through lib -> src');
  });
  await inRepo({}, { 'src/a': '1\n', 'tooling/checks/a.sh': counting('a', 'src'), 'tooling/checks/o.sh': counting('o', 'other'), 'other/b': '1\n' }, () => {
    onMain(() => { for (const f of ['a', 'o']) fs.chmodSync(path.join(dir, `tooling/checks/${f}.sh`), 0o755); link('tooling', 'ci');
      write('eng.config.yml', YAML.stringify(config({ flake_runs_pr: 1, pr_checks: 'affected', checks_dir: 'ci/checks' }))); });
    write('tooling/checks/a.sh', counting('a', 'src', 1)); git('commit -qam target');
    failsAndRan(gatePr(), { a: 1, o: 1 }, 'checks_dir ci/checks through ci -> tooling');
  });
});

test('symlinks: a covered path that is a symlinked folder, or holds a symlink, follows its target', async () => {
  await inRepo({ s: breaks('s', 'lib'), t: breaks('t', 'pkg'), o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n', 'pkg/real.txt': 'r\n' }, () => {
    onMain(() => { link('src', 'lib'); link('../src/a', 'pkg/a'); });
    write('src/a', 'broken\n'); git('commit -qam target');
    failsAndRan(gatePr(), { s: 1, t: 1 }, 'covers lib -> src, and pkg holding pkg/a -> ../src/a');
  });
});

test('symlinks: a check file or covered path pointing outside the repo always runs', async () => {
  await inRepo({ o: counting('o', 'other'), x: counting('x', 'ext') }, { 'src/a': '1\n', 'other/b': '1\n', 'docs/x': 'x\n' }, () => {
    const outside = fs.mkdtempSync(path.join(path.dirname(dir), 'eng-select-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'a.sh'), counting('a', 'src', 1), { mode: 0o755 });
      onMain(() => { link(path.join(outside, 'a.sh'), '.eng/checks/a.sh'); link(outside, 'ext'); });
      write('docs/x', 'y\n'); git('commit -qam docs');
      const r = gatePr(); failsAndRan(r, { a: 1, o: 1, x: 1 }, 'outside targets: the symlinked check runs every check');
      assert.match(r.stdout, /checks: all 3, because verification\.checks_dir \.eng\/checks is, holds or goes through a symlink/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test('symlinks: a retargeted symlink on the way to a covered path runs the check', async () => {
  await inRepo({ k: counting('k', 'lib/a.js').replace('exit 0', 'grep -q broken lib/a.js && exit 1; exit 0'), o: counting('o', 'other') },
    { 'v1/a.js': '1\n', 'v2/a.js': 'broken\n', 'other/b': '1\n' }, () => {
      onMain(() => link('v1', 'lib'));
      fs.rmSync(path.join(dir, 'lib')); link('v2', 'lib'); git('commit -qam retarget');
      const r = gatePr(); failsAndRan(r, { k: 1, o: 1 }, 'lib retargeted from v1 to v2: a changed symlink runs every check');
      assert.match(r.stdout, /checks: all 2, because lib is a symlink this change adds, removes or changes/);
    });
  assert.equal(affectedBy(['lib'], '.eng/checks').runs({ covers: ['lib/a.js'] }), true, 'a changed folder on the way counts');
  assert.deepEqual(affectedBy(['.eng'], '.eng/checks'), { all: '.eng changed' }, 'a retargeted parent of the checks dir runs every check');
});

// Round 5: symlinks are not traced. A changed symlink runs every check; a check reached through a symlink always runs.
const relink = (target, at) => { fs.rmSync(path.join(dir, at)); link(target, at); };
const reading = (id, p) => counting(id, p).replace('exit 0', `grep -q broken ${p} && exit 1; exit 0`);
const allBecause = (r, re) => assert.match(r.stdout, re, out(r));

test('symlinks: retargeting the middle hop of a chain to a covered path runs every check and fails', async () => {
  // round 5 finding: covers a, a -> b -> src/a; retarget only b (keeping the old link as old-b).
  await inRepo({ k: reading('k', 'a'), o: counting('o', 'other') }, { 'src/a': 'ok\n', 'other/a': 'broken\n' }, () => {
    onMain(() => { link('src/a', 'b'); link('b', 'a'); });
    link('src/a', 'old-b'); relink('other/a', 'b'); git('add -A'); git('commit -qm retarget');
    const r = gatePr(); failsAndRan(r, { k: 1, o: 1 }, 'a -> b -> src/a, b retargeted');
    allBecause(r, /checks: all 2, because b is a symlink this change adds, removes or changes/);
  });
  // round 5 finding: covers lib/a, lib -> route -> src; retarget route to other. and: covers lib, lib -> mid -> v1.
  const tree = counting('m', 'lib').replace('exit 0', 'grep -rq broken lib/ && exit 1; exit 0');
  await inRepo({ k: reading('k', 'lib/a'), m: tree, o: counting('o', 'docs') }, { 'src/a': 'ok\n', 'other/a': 'broken\n', 'docs/x': 'x\n' }, () => {
    onMain(() => { link('src', 'route'); link('route', 'lib'); });
    relink('other', 'route'); git('add -A'); git('commit -qm retarget');
    const r = gatePr(); failsAndRan(r, { k: 1, m: 1, o: 1 }, 'lib -> route -> src, route retargeted');
  });
});

test('symlinks: a covered path behind a chain (lib -> mid -> v1, pkg/x -> mid -> v1) always runs, even when only the target changes', async () => {
  await inRepo({ s: reading('s', 'lib/a.js'), t: reading('t', 'pkg/x/a.js'), o: counting('o', 'other') }, { 'v1/a.js': '1\n', 'v2/a.js': 'broken\n', 'other/b': '1\n', 'pkg/real': 'r\n', 'docs/x': 'x\n' }, () => {
    onMain(() => { link('v1', 'mid'); link('mid', 'lib'); link('../mid', 'pkg/x'); });
    // The PR changes only v1/a.js, a tracked file neither check names: both still run, because their covered paths go
    // through symlinks; o does not.
    write('v1/a.js', 'broken\n'); git('commit -qam target');
    let r = gatePr(); failsAndRan(r, { s: 1, t: 1 }, 'chain target changed');
    assert.match(r.stdout, /checks: 2 of 3/);
    // round 5 finding, row 4 and 5: retarget mid to v2 (its a.js is broken). The changed link runs every check.
    git('checkout -q main'); git('checkout -q -B pr'); relink('v2', 'mid'); git('add -A'); git('commit -qm retarget');
    r = gatePr(); failsAndRan(r, { s: 1, t: 1, o: 1 }, 'mid retargeted');
    allBecause(r, /because mid is a symlink this change adds, removes or changes/);
  });
});

test('symlinks: a check reached through a chain, or whose target becomes a link, runs every check and fails', async () => {
  const pass = counting('a', 'src'), fail = counting('a', 'src', 1);
  // round 5 finding: .eng/checks/a.sh -> ../../route -> scripts/pass.sh; retarget route to scripts/fail.sh.
  await inRepo({ o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n' }, () => {
    onMain(() => { write('scripts/pass.sh', pass, 0o755); write('scripts/fail.sh', fail, 0o755); link('scripts/pass.sh', 'route'); link('../../route', '.eng/checks/a.sh'); });
    relink('scripts/fail.sh', 'route'); git('add -A'); git('commit -qm retarget');
    failsAndRan(gatePr(), { a: 1, o: 1 }, 'a.sh -> route -> scripts, route retargeted');
  });
  // round 5 finding, row 1: .eng/checks/a.sh -> ../../scripts/ok.sh; scripts/ok.sh becomes a link to scripts/fail.sh.
  await inRepo({ o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n' }, () => {
    onMain(() => { write('scripts/ok.sh', pass, 0o755); write('scripts/fail.sh', fail, 0o755); link('../../scripts/ok.sh', '.eng/checks/a.sh'); });
    relink('fail.sh', 'scripts/ok.sh'); git('add -A'); git('commit -qm becomes-link');
    const r = gatePr(); failsAndRan(r, { a: 1, o: 1 }, 'check target becomes a link');
    allBecause(r, /because scripts\/ok\.sh is a symlink this change adds, removes or changes/);
  });
  // round 5 finding, row 3: .eng/checks/a.sh -> ../../mid.sh -> scripts/ok.sh; mid.sh -> scripts/fail.sh.
  await inRepo({ o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n' }, () => {
    onMain(() => { write('scripts/ok.sh', pass, 0o755); write('scripts/fail.sh', fail, 0o755); link('scripts/ok.sh', 'mid.sh'); link('../../mid.sh', '.eng/checks/a.sh'); });
    relink('scripts/fail.sh', 'mid.sh'); git('add -A'); git('commit -qm retarget');
    failsAndRan(gatePr(), { a: 1, o: 1 }, 'a.sh -> mid.sh retargeted');
  });
});

test('symlinks: a checks dir chain (.eng/checks -> ../cdir -> v1checks) whose middle hop is retargeted runs every check and fails', async () => {
  await inRepo({}, { 'src/a': '1\n', 'v1checks/a.sh': counting('a', 'src'), 'v2checks/a.sh': counting('a', 'src', 1), 'other/b': '1\n' }, () => {
    onMain(() => { for (const f of ['v1checks/a.sh', 'v2checks/a.sh']) fs.chmodSync(path.join(dir, f), 0o755); link('v1checks', 'cdir'); link('../cdir', '.eng/checks'); });
    relink('v2checks', 'cdir'); git('add -A'); git('commit -qm retarget');
    failsAndRan(gatePr(), { a: 1 }, 'checks dir chain, cdir retargeted');
    // Committed with no symlink change, a checks dir that goes through a link still runs every check.
    git('checkout -q main'); git('checkout -q -B pr'); write('v1checks/a.sh', counting('a', 'src', 1)); git('commit -qam target');
    const r = gatePr(); failsAndRan(r, { a: 1 }, 'checks dir chain, target changed');
    allBecause(r, /because verification\.checks_dir \.eng\/checks is, holds or goes through a symlink/);
  });
});

test('symlinks: a git-ignored or untracked link inside a covered folder makes the check always run', async () => {
  // round 5 finding: covers covered; covered/link -> ../src/a is ignored; the PR changes only the tracked src/a.
  await inRepo({ k: counting('k', 'covered').replace('exit 0', 'grep -q broken covered/link && exit 1; exit 0'), o: counting('o', 'other') },
    { 'covered/keep': 'k\n', '.gitignore': 'covered/link\n', 'src/a': 'ok\n', 'other/b': '1\n' }, () => {
      link('../src/a', 'covered/link');
      assert.equal(git('status --porcelain'), '', 'the link is ignored');
      write('src/a', 'broken\n'); git('commit -qam target');
      assert.equal(git('diff --name-only main HEAD'), 'src/a');
      const r = gatePr(); failsAndRan(r, { k: 1 }, 'ignored link inside a covered folder');
      assert.match(r.stdout, /checks: 1 of 2/);
    });
  // An uncommitted symlink (untracked, or a dirty retarget) is a changed symlink: every check runs.
  await inRepo({ k: reading('k', 'lib/a'), o: counting('o', 'other') }, { 'src/a': 'ok\n', 'bad/a': 'broken\n', 'other/b': '1\n', 'docs/x': 'x\n' }, () => {
    onMain(() => { link('src', 'route'); link('route', 'lib'); });
    write('docs/x', 'y\n'); git('commit -qam docs'); relink('bad', 'route');
    let r = gatePr(); failsAndRan(r, { k: 1, o: 1 }, 'dirty retarget of route');
    allBecause(r, /because route is a symlink this change adds, removes or changes/);
    relink('src', 'route'); link('src/a', 'new-link');
    r = gatePr(); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { k: 1, o: 1 }, 'an untracked new link runs every check');
    allBecause(r, /because new-link is a symlink this change adds, removes or changes/);
  });
});

// Round 6 (both round-6 verifiers on f65142b): normalising link/../src to src hid the link hop, so a change under
// the link's target skipped the check. Fail closed: a covers path or a changed path that is not canonical (a . or ..
// segment, an empty segment, a leading /, a backslash) is never normalised for selection.
test('round 6: a covers path with .. after a symlink (alias/../src, link/../src/a) runs the check and fails', async () => {
  // first finding: alias -> other/deep; the check reads alias/../src/a, which is other/src/a.
  await inRepo({ a: counting('a', 'alias/../src').replace('exit 0', 'grep -q broken alias/../src/a && exit 1; exit 0'), o: counting('o', 'docs') },
    { 'src/a': 'healthy\n', 'other/src/a': 'healthy\n', 'other/deep/keep': 'k\n', 'docs/x': 'x\n' }, () => {
      onMain(() => link('other/deep', 'alias'));
      write('other/src/a', 'broken\n'); git('commit -qam broken');
      assert.equal(git('diff --name-only main HEAD'), 'other/src/a');
      const r = gatePr(); failsAndRan(r, { a: 1 }, 'covers alias/../src');
      assert.match(r.stdout, /checks: 1 of 2, those whose # covers: paths changed against main, and a \(# covers: alias\/\.\.\/src is not canonical/);
      assert.equal(eng(['gate', 'checks', '--event', 'main']).status, 1, 'main runs it and fails too'); ran();
    });
  // second finding: link -> other/nested; covers link/../src/a, and link/../src/d/b.js.
  for (const [cover, changed] of [['link/../src/a', 'other/src/a'], ['link/../src/d/b.js', 'other/src/d/b.js']]) {
    await inRepo({ a: counting('a', cover).replace('exit 0', `grep -q broken ${cover} && exit 1; exit 0`), o: counting('o', 'docs') },
      { 'src/a': 'ok\n', 'src/d/b.js': 'ok\n', 'other/src/a': 'ok\n', 'other/src/d/b.js': 'ok\n', 'other/nested/keep': 'k\n', 'docs/x': 'x\n' }, () => {
        onMain(() => link('other/nested', 'link'));
        write(changed, 'broken\n'); git('commit -qam broken');
        failsAndRan(gatePr(), { a: 1 }, `covers ${cover}, ${changed} changed`);
      });
  }
});

test('round 6: a non-canonical covers path always runs its check; a canonical one still selects (controls)', async () => {
  const forms = ['other/../src/a', './src/a', 'src/./a', 'src//a', 'src/a/', 'src\\a'];
  await inRepo(Object.fromEntries(forms.map((c, i) => [`n${i}`, counting(`n${i}`, c)]).concat([['k', counting('k', 'src/a')], ['o', counting('o', 'other/src/a')]])),
    { 'src/a': 'ok\n', 'src\\a': 'b\n', 'other/src/a': 'ok\n', 'docs/x': 'x\n' }, () => {
      write('docs/x', 'y\n'); git('commit -qam docs');
      const r = gatePr(); assert.equal(r.status, 0, out(r));
      assert.deepEqual(ran(), Object.fromEntries(forms.map((_, i) => [`n${i}`, 1])), 'every non-canonical covers path runs; k and o (canonical) are unaffected');
      git('checkout -q main'); git('checkout -q -B pr'); write('src/a', 'v2\n'); git('commit -qam a');
      assert.equal(gatePr().status, 0); assert.deepEqual(ran(), { ...Object.fromEntries(forms.map((_, i) => [`n${i}`, 1])), k: 1 }, 'a change to src/a selects k, not o');
    });
  const runs = (covers, files) => affectedBy(files, '.eng/checks').runs({ covers });
  for (const c of ['other/../src', './src', 'src/', 'a//b', 'a\\b', '.', 'a/.', 'a/..']) assert.equal(runs([c], ['docs/x']), true, `${c} always runs`);
  assert.equal(runs(['src'], ['docs/x']), false, 'a canonical path that did not change does not run');
});

test('round 6: a changed path that is not canonical (a backslash) runs every check', async () => {
  await inRepo({ k: counting('k', 'src'), o: counting('o', 'other') }, { 'src/a': '1\n', 'other/b': '1\n', 'docs/x': 'x\n' }, () => {
    write('docs/a\\b', 'x\n'); git('add -A'); git('commit -qm backslash');
    const r = gatePr(); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { k: 1, o: 1 });
    assert.match(r.stdout, /checks: all 2, because docs\/a\\b is not a canonical path/);
  });
  assert.match(affectedBy(['x/../y'], '.eng/checks').all, /x\/\.\.\/y is not a canonical path/);
});

test('round 6: the selection line names each check that runs under a rule other than a changed covered path', async () => {
  await inRepo({ k: counting('k', 'pkg'), n: counting('n', './src'), c: counting('c', null), d: counting('d', 'src'), o: counting('o', 'other') },
    { 'pkg/real': 'r\n', 'src/a': '1\n', 'other/b': '1\n' }, () => {
      onMain(() => link('../src/a', 'pkg/a'));
      write('src/a', '2\n'); git('commit -qam a');
      const r = gatePr(); assert.equal(r.status, 0, out(r)); assert.deepEqual(ran(), { c: 1, d: 1, k: 1, n: 1 });
      assert.match(r.stdout, /checks: 4 of 5, those whose # covers: paths changed against main, and c \(no # covers: line\), k \(# covers: pkg holds a symlink\), n \(# covers: \.\/src is not canonical: [^)]*\) \(verification\.pr_checks: affected\)/);
    });
});

test('round 6: SHIPPING.md claims a revert on red main only when the repo has one (merge.auto)', () => {
  const cwd = process.cwd(); process.chdir(dir);
  try {
    const plain = shippingMd(config({ flake_runs_pr: 1, pr_checks: 'affected' }));
    assert.doesNotMatch(plain, /reverted like any red main/);
    assert.doesNotMatch(plain, /exact-inverse revert|exact inverse as a revert/);
    assert.match(plain, /runs every check 3 times after every merge, and a failing or flaky check there turns main red\./);
    const auto = config({ flake_runs_pr: 1 }); auto.merge = { ...auto.merge, auto: { high_risk_paths: ['x'], post_merge: { check: 'eng gate' } } };
    assert.match(shippingMd(auto), /runs every check 3 times after every merge, and a failing or flaky check there turns main red\. When main's post-merge check \(`eng gate`, `merge\.auto\.post_merge\.check`\) fails, `eng merge post` opens the merge's exact inverse as a revert PR\./);
  } finally { process.chdir(cwd); }
});
