// Checks are chosen and sized up front (Matt, 8 Nov 2026): a check declares its weight and budget, eng gate enforces the
// budget on both paths, eng run -- bounds one-off commands, and eng lint flags a heavy tool with no bound. Every budget
// here is small, so a test that fails to enforce cannot take the machine with it: the allocator stops itself at 1.5 GB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { parseBudget, checkSpec, admit, toolEnv, enforcer, DEFAULT_BUDGET } from '../lib/budget.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const TPL = path.join(PKG, 'templates/eng.config.yml');
const out = r => r.stdout + r.stderr;
const systemd = (() => { try { return enforcer({}) === 'systemd'; } catch { return false; } })();
const NO_SYSTEMD = 'systemd-run --user --scope does not work on this machine (no user systemd manager), so only the watchdog path runs here';
// 32 MB every 30 ms, up to 1.5 GB, then exit 0: unbounded it passes, so only a working budget makes it fail.
const ALLOC = `node -e 'const a=[];let n=0;const t=setInterval(()=>{if(n<48){a.push(Buffer.alloc(32<<20,1));n++}else{clearInterval(t);setTimeout(()=>process.exit(0),2000)}},30)'`;

let dir;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
// Each run sees no CI variable unless the test sets one, so the stage is what the test says.
const eng = (args, env = {}) => { const e = { ...process.env, ...env }; if (!('CI' in env)) delete e.CI; return spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: e }); };
const checks = files => {
  fs.rmSync(path.join(dir, '.eng/checks'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, '.eng/checks'), { recursive: true });
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.eng/checks', `${n}.sh`), body, { mode: 0o755 });
  git('add -A'); git('commit -qm checks --allow-empty');
};

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-budget-'));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  c.gates.required = []; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.verification.flake_runs = 1;
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a budget parses from a check header; missing parts and a missing header take the default', () => {
  assert.deepEqual(parseBudget('memory=768M workers=1 timeout=120s'), { memoryMb: 768, workers: 1, timeoutS: 120 });
  assert.deepEqual(parseBudget('memory=2G timeout=10m'), { memoryMb: 2048, timeoutS: 600 });
  assert.match(parseBudget('memory=lots').error, /not a size/);
  assert.match(parseBudget('cpu=2').error, /not a budget part/);
  assert.deepEqual(checkSpec('#!/bin/sh\ntrue\n'), { weight: 'light', budget: DEFAULT_BUDGET, declared: false });
  assert.deepEqual(checkSpec('# weight: heavy\n# budget: memory=512M\n'), { weight: 'heavy', budget: { ...DEFAULT_BUDGET, memoryMb: 512 }, declared: true });
  assert.match(checkSpec('# weight: medium\n').error, /light or heavy/);
  const env = toolEnv({ memoryMb: 1024, workers: 1, timeoutS: 60 }, { NODE_OPTIONS: '--enable-source-maps' });
  assert.equal(env.JAVA_TOOL_OPTIONS, '-Xmx768m -XX:ActiveProcessorCount=1');
  assert.equal(env.NODE_OPTIONS, '--enable-source-maps --max-old-space-size=768', 'the caller\'s NODE_OPTIONS stay');
  assert.equal(env.GRADLE_OPTS, '-Dorg.gradle.workers.max=1');
});
// PR 50, round 10: a check inside an `eng run --budget` inherited the run's flags and got eng's own flags twice.
test('tool flags inside an outer eng budget replace the flags eng set there and keep the user\'s own', () => {
  const outer = toolEnv(DEFAULT_BUDGET, { JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8', NODE_OPTIONS: '--enable-source-maps' });
  const same = toolEnv(DEFAULT_BUDGET, outer), inner = toolEnv({ memoryMb: 1024, workers: 1, timeoutS: 60 }, outer);
  assert.equal(same.JAVA_TOOL_OPTIONS, '-Dfile.encoding=UTF-8 -Xmx1536m -XX:ActiveProcessorCount=2');
  assert.equal(same.NODE_OPTIONS, '--enable-source-maps --max-old-space-size=1536');
  assert.equal(same.GRADLE_OPTS, '-Dorg.gradle.workers.max=2');
  assert.equal(inner.JAVA_TOOL_OPTIONS, '-Dfile.encoding=UTF-8 -Xmx768m -XX:ActiveProcessorCount=1');
  assert.equal(inner.NODE_OPTIONS, '--enable-source-maps --max-old-space-size=768');
  assert.equal(inner.GRADLE_OPTS, '-Dorg.gradle.workers.max=1');
  const own = toolEnv(DEFAULT_BUDGET, { ENG_BUDGET_HEAP_MB: '1536', ENG_BUDGET_WORKERS: '2', JAVA_TOOL_OPTIONS: '-Xmx1536m -XX:ActiveProcessorCount=2 -Dx=1' });
  assert.equal(own.JAVA_TOOL_OPTIONS, '-Xmx1536m -XX:ActiveProcessorCount=2 -Dx=1 -Xmx1536m -XX:ActiveProcessorCount=2', 'flags that are not eng\'s trailing ones are the user\'s and stay');
});

test('admission: a check starts only while the budgets fit; one bigger than the machine never starts', () => {
  const m = { memoryMb: 1000, cores: 4 }, b = (memoryMb, workers = 1) => ({ memoryMb, workers, timeoutS: 1 });
  assert.equal(admit(b(600), [], m), 'start');
  assert.equal(admit(b(600), [b(600)], m), 'wait');
  assert.equal(admit(b(300), [b(600)], m), 'start');
  assert.equal(admit(b(100, 2), [b(100, 3)], m), 'wait', 'cores count too');
  assert.equal(admit(b(2000), [], m), 'never');
});

for (const how of ['systemd', 'watchdog']) test(`a check over its 512 MB budget is stopped and fails eng gate, naming the budget (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  checks({ hog: `#!/usr/bin/env bash\n# budget: memory=512M workers=1 timeout=60s\n${ALLOC}\n` });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: how });
  t.diagnostic(out(r));
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, how === 'systemd' ? /enforced by systemd user scope/ : /enforced by watchdog/);
  assert.match(r.stdout, /FAIL\s+check:hog\s+eng: FAIL check hog: stopped by its budget: memory 512 MB .*declared budget memory 512 MB, 1 worker, timeout 60s/);
  if (how === 'systemd') assert.match(r.stdout, /the kernel killed it at MemoryMax/);
  else assert.match(r.stdout, process.platform === 'linux' ? /the process tree reached \d+ MB PSS/ : /the process tree reached \d+ MB RSS/);
  if (how === 'systemd') assert.equal(spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', 'eng-check-hog-*'], { encoding: 'utf8' }).stdout.trim(), '', 'the transient scope is removed');
});

test('a check that runs past its timeout is stopped and fails, naming the budget', () => {
  checks({ slow: '#!/usr/bin/env bash\n# budget: timeout=1s\nsleep 30\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /eng: FAIL check slow: stopped by its budget: timeout 1s/);
});

test('a check with no budget runs under the default, and its tools get the matching flags', () => {
  checks({ plain: '#!/usr/bin/env bash\ngot="mem=$ENG_BUDGET_MEMORY_MB workers=$ENG_BUDGET_WORKERS java=$JAVA_TOOL_OPTIONS"\n[ "$got" = "mem=2048 workers=2 java=-Xmx1536m -XX:ActiveProcessorCount=2" ] || { echo "eng: FAIL check saw $got"; exit 1; }\n' });
  const r = eng(['gate', 'checks'], toolEnv(DEFAULT_BUDGET, {}));
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /start\s+check:plain \(light, default budget: memory 2048 MB, 2 workers, timeout 1800s\)/);
  assert.match(r.stdout, /pass\s+check:plain check plain: passed 1\/1/);
});

test('a header eng cannot read fails the check and says why', () => {
  checks({ odd: '#!/bin/sh\n# budget: memory=lots\ntrue\n' });
  const r = eng(['gate', 'checks']);
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /check odd: .*# budget: memory=lots is not a size/);
});

test('a heavy check runs in CI or with --heavy, and is listed as deferred, not passed, in a local run', () => {
  checks({ light: '#!/bin/sh\nexit 0\n', model: '#!/bin/sh\n# weight: heavy\n# budget: memory=256M workers=1\nexit 1\n' });
  let r = eng(['gate', 'checks']);
  assert.equal(r.status, 3, out(r));
  assert.match(r.stdout, /stage: light \(heavy checks run in CI, or here with eng gate --heavy\)/);
  assert.match(r.stdout, /deferred\s+check:model heavy check, not run in this stage/);
  assert.match(r.stdout, /eng gate: INCOMPLETE \(exit 3\)\. The light checks passed, and every other step that ran\. Deferred, not run: model\./);
  r = eng(['gate', 'checks', '--heavy']);
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /stage: light and heavy \(--heavy\)/); assert.match(r.stdout, /FAIL\s+check:model/);
  r = eng(['gate', 'checks'], { CI: 'true' });
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /stage: light and heavy \(CI\)/); assert.match(r.stdout, /FAIL\s+check:model/);
});

const spans = (file, ids) => { const l = fs.readFileSync(file, 'utf8').trim().split('\n').map(x => x.split(' ')); return ids.map(id => [Number(l.find(x => x[0] === id && x[1] === 'start')[2]), Number(l.find(x => x[0] === id && x[1] === 'end')[2])]); };
const timed = (id, mem) => `#!/usr/bin/env bash\n# weight: heavy\n# budget: memory=${mem}M workers=1 timeout=60s\necho "${id} start $(date +%s%N)" >> "$TIMES"; sleep 1; echo "${id} end $(date +%s%N)" >> "$TIMES"\n`;
test('a check whose budget is more than the free memory is not started, and fails saying so', () => {
  checks({ big: '#!/bin/sh\n# budget: memory=4G\nexit 0\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_FREE_MB: '1000' });
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /check big: not started: its budget \(memory 4096 MB, 2 workers, timeout 1800s\) is more than the 1000 MB free here/);
});

for (const how of ['systemd', 'watchdog']) test(`eng run -- java with no bounds runs inside the default budget (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const bin = path.join(dir, '.git', 'fakebin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho "java saw JAVA_TOOL_OPTIONS=$JAVA_TOOL_OPTIONS"\necho "java cgroup memory.max=$(cat /sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.max 2>/dev/null)"\n', { mode: 0o755 });
  const r = eng(['run', '--', 'java', '-jar', 'tla2tools.jar'], { PATH: `${bin}:${process.env.PATH}`, ENG_BUDGET_ENFORCER: how });
  t.diagnostic(out(r));
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /budget: memory 2048 MB, 2 workers, timeout 1800s \(default; set one with --budget\)/);
  assert.match(r.stdout, /java saw JAVA_TOOL_OPTIONS=-Xmx1536m -XX:ActiveProcessorCount=2/);
  if (how === 'systemd') assert.match(r.stdout, /java cgroup memory\.max=2147483648/, 'the kernel limit is the budget');
});

for (const how of ['systemd', 'watchdog']) test(`eng run -- stops a command over its --budget and names it (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const r = eng(['run', '--budget', 'memory=256M workers=1 timeout=60s', '--', 'bash', '-c', ALLOC], { ENG_BUDGET_ENFORCER: how });
  t.diagnostic(out(r));
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stderr, /eng: FAIL run: bash stopped by its budget: memory 256 MB .*--budget budget memory 256 MB, 1 worker, timeout 60s/);
});

test('eng lint flags java without -Xmx in a check script, and passes once it is bounded', () => {
  checks({ model: '#!/usr/bin/env bash\n# weight: heavy\njava -cp tla2tools.jar tlc2.TLC -workers 1 Spec.tla\n' });
  let r = eng(['lint']);
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /\.eng\/checks\/model\.sh:3: \[heavy-tool-unbounded\] Heavy tool without a bound/);
  checks({ model: '#!/usr/bin/env bash\n# weight: heavy\njava -Xmx"${ENG_BUDGET_HEAP_MB:-768}m" -cp tla2tools.jar tlc2.TLC -workers 1 Spec.tla\n./gradlew test --max-workers=2\n# java in a comment is fine\n' });
  r = eng(['lint']);
  assert.equal(r.status, 0, out(r));
  checks({ model: '#!/usr/bin/env bash\n./gradlew check\n' });
  r = eng(['lint']); assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /model\.sh:2: \[heavy-tool-unbounded\]/);
});

test('the suggested TLC script refuses a jar whose checksum is wrong, and passes its bounds to java', () => {
  const work = fs.mkdtempSync(path.join(dir, '.git', 'tlc-')), cache = path.join(work, 'cache'), bin = path.join(work, 'bin');
  fs.mkdirSync(cache); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho "java $*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cache, 'tla2tools-1.7.4.jar'), 'not the real jar');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ENG_DOWNLOAD_CACHE: cache, ENG_TMP: work };
  for (const k of ['ENG_BUDGET_HEAP_MB', 'ENG_BUDGET_WORKERS', 'ENG_BUDGET_TIMEOUT_S']) delete env[k];
  let r = spawnSync('bash', [path.join(PKG, 'standard/tools/tlc.sh'), 'Spec.tla'], { encoding: 'utf8', env });
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /has SHA-256 \w+, want 936a2620.*not running it/); assert.doesNotMatch(r.stdout, /^java/m);
  // The same script with the pin pointed at the stand-in jar shows the arguments it hands java.
  const sha = crypto.createHash('sha256').update('not the real jar').digest('hex'), copy = path.join(work, 'tlc.sh');
  fs.writeFileSync(copy, fs.readFileSync(path.join(PKG, 'standard/tools/tlc.sh'), 'utf8').replace(/^TLA_SHA256=.*$/m, `TLA_SHA256=${sha}`));
  r = spawnSync('bash', [copy, 'Spec.tla', 'Spec.cfg'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /^java -Xmx768m .*tlc2\.TLC -workers 1 .*-config Spec\.cfg Spec\.tla$/m);
  r = spawnSync('bash', [copy, 'Spec.tla'], { encoding: 'utf8', env: { ...env, ENG_BUDGET_HEAP_MB: '384', ENG_BUDGET_WORKERS: '2' } });
  assert.match(r.stdout, /^java -Xmx384m .*-workers 2 /m, 'under eng the check\'s budget sets the bounds');
});

test('every tool in the suggested catalog states its cost, when it earns it, and a budget eng can read', () => {
  const cat = YAML.parse(fs.readFileSync(path.join(PKG, 'standard/checks.yml'), 'utf8'));
  for (const [name, x] of Object.entries(cat.tools)) {
    for (const k of ['use', 'runtime', 'memory', 'time', 'earns_its_cost_when']) assert.ok(typeof x[k] === 'string' && x[k].trim(), `${name}.${k}`);
    assert.ok(['light', 'heavy'].includes(x.weight), `${name}.weight`);
    assert.equal(parseBudget(x.budget).error, undefined, `${name}.budget`);
  }
  for (const jvm of ['tlc', 'apalache', 'alloy']) { assert.equal(cat.tools[jvm].weight, 'heavy', `${jvm} is heavy`); assert.match(cat.tools[jvm].earns_its_cost_when, /concurrency|distributed|relations/); }
  assert.equal(cat.tools['property-tests'].weight, 'light');
});

// ---------- verdict findings on 02a7b0a (PR 50, independent checker): a budget stop, a deferred check or a leftover process
// never counts as a pass ----------
const runLogFile = () => path.join(dir, '.git', 'eng', 'verdict-runs.jsonl');
const runsBy = by => fs.existsSync(runLogFile()) ? fs.readFileSync(runLogFile(), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.by === by) : [];
// A killed process another reaper has not collected yet (eng run <name> makes one the subreaper) is a zombie: gone.
const alive = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '')[0] !== 'Z'; } catch { if (process.platform === 'linux') return false; try { process.kill(pid, 0); return true; } catch { return false; } } };
const scopes = pattern => spawnSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', pattern], { encoding: 'utf8' }).stdout.trim();
const dropScopes = pattern => { for (const l of scopes(pattern).split('\n').filter(Boolean)) { const u = l.split(/\s+/)[0]; spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', u]); spawnSync('systemctl', ['--user', 'stop', u]); spawnSync('systemctl', ['--user', 'reset-failed', u]); } };
const hows = ['systemd', 'watchdog'];

// ---------- the watchdog counts memory the way the kernel does (PR 51 verdict 1: summed RSS counted the node binary
// and libraries once per process, so the watchdog killed a suite at 2154 MB that the 2 GB scope ran at about 1.3 GB). ----------
// Twenty idle node processes: about 40 MB RSS each, almost all of it pages they share. The leader prints their summed RSS,
// so the test shows the RSS sum was over the budget while it ran. Their own pages are about 16 MB each (PSS ~320 MB): the budget
// sits well between the two (PR #53 verdict 3: a 320 MB budget left 1 MB of margin and failed under load).
const SHARERS = `const { spawn } = require('child_process'), fs = require('fs');
const kids = Array.from({ length: 20 }, () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' }));
setTimeout(() => { const kb = kids.reduce((s, k) => { try { return s + Number(fs.readFileSync('/proc/' + k.pid + '/stat', 'utf8').replace(/^.*\\) /, '').split(' ')[21]) * 4; } catch { return s; } }, 0); console.log('rss_sum_mb=' + Math.round(kb / 1024)); }, 2500);`;
test('processes that share their pages stay under a budget their summed RSS exceeds (watchdog path)', { skip: process.platform !== 'linux' && 'PSS is Linux only; macOS sums ps RSS' }, () => {
  const r = eng(['run', '--budget', 'memory=600M workers=1 timeout=60s', '--', process.execPath, '-e', SHARERS], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.doesNotMatch(out(r), /stopped by its budget/);
  assert.equal(r.status, 0, out(r));
  const rss = Number(r.stdout.match(/rss_sum_mb=(\d+)/)?.[1]);
  assert.ok(rss > 600, `the children's summed RSS (${rss} MB) is over the 600 MB budget, so only shared pages separate the two measures: ${out(r)}`);
});
// Four processes, each 160 MB of its own memory: none is over 256 MB alone, the tree is.
const SPREAD = `for i in 1 2 3 4; do node -e 'const a=[];let n=0;const t=setInterval(()=>{if(n<5){a.push(Buffer.alloc(32<<20,1));n++}else{clearInterval(t);setTimeout(()=>process.exit(0),3000)}},30)' & done; wait`;
for (const how of hows) test(`a process tree whose own memory is over budget is still stopped, naming the budget (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const r = eng(['run', '--budget', 'memory=256M workers=1 timeout=60s', '--', 'bash', '-c', SPREAD], { ENG_BUDGET_ENFORCER: how });
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stderr, /eng: FAIL run: bash stopped by its budget: memory 256 MB/);
  assert.match(out(r), how === 'systemd' ? /the kernel killed it at MemoryMax/ : process.platform === 'linux' ? /the process tree reached \d+ MB PSS/ : /the process tree reached \d+ MB RSS/);
  assert.match(r.stdout, how === 'systemd' ? /enforced by systemd user scope/ : process.platform === 'linux' ? /enforced by watchdog \(timeout and process-tree PSS poll\)/ : /enforced by watchdog/);
});

// A shell outside a login session (PR 51's verifier) has no XDG_RUNTIME_DIR and no session bus address while the user
// manager runs. eng finds it at /run/user/<uid>, but only when that directory is ours, mode 0700, with a bus socket.
const RUNTIME = `/run/user/${process.getuid?.()}`;
const noSession = () => { const e = { ...process.env }; for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'ENG_BUDGET_ENFORCER']) delete e[k]; delete e.CI; return e; };
const managerAt = d => spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { env: { ...noSession(), XDG_RUNTIME_DIR: d }, stdio: 'ignore', timeout: 10e3 }).status === 0;
const PICK = `import(${JSON.stringify(new URL('../lib/budget.mjs', import.meta.url).href)}).then(m => console.log(m.enforcer()))`;
const pickIn = (bwrap = null) => { const r = spawnSync(bwrap ? 'bwrap' : process.execPath, [...(bwrap ? ['--dev-bind', '/', '/', ...bwrap, '--', process.execPath] : []), '-e', PICK], { env: noSession(), encoding: 'utf8' }); return (r.stdout.trim() || r.stderr.trim()); };
const NO_MANAGER = `no user systemd manager answers at ${RUNTIME}`;
test('with no XDG_RUNTIME_DIR, eng finds the user manager at /run/user/<uid>: enforcer() is systemd and a run over budget is killed in a scope that is then removed', { skip: process.platform !== 'linux' && 'Linux only' }, t => {
  if (!managerAt(RUNTIME)) return t.skip(NO_MANAGER);
  assert.equal(pickIn(), 'systemd');
  const r = spawnSync(process.execPath, [ENG, 'run', '--budget', 'memory=256M workers=1 timeout=60s', '--', 'bash', '-c', ALLOC], { cwd: dir, encoding: 'utf8', env: noSession() });
  try {
    assert.notEqual(r.status, 0, out(r));
    assert.match(r.stdout, /enforced by systemd user scope/);
    assert.match(r.stderr, /stopped by its budget: memory 256 MB \(the kernel killed it at MemoryMax\)/);
    assert.equal(scopes(`eng-run-${r.pid}-*`), '', 'the scope is removed: systemctl reached the manager too');
  } finally { dropScopes(`eng-run-${r.pid}-*`); }
});
const bwrapWorks = () => spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true'], { stdio: 'ignore' }).status === 0;
for (const [name, setup] of [
  ['missing', () => ['--tmpfs', '/run/user']],
  ['owned by another user', () => fs.lstatSync('/root').uid === 0 ? ['--tmpfs', '/run/user', '--bind', '/root', RUNTIME] : null],
  // Ours and holding the live bus socket, so only the mode check stops eng from using it.
  ['ours but not mode 0700', d => { fs.chmodSync(d, 0o755); return ['--bind', d, RUNTIME, '--bind', `${RUNTIME}/bus`, `${RUNTIME}/bus`]; }],
]) test(`with no XDG_RUNTIME_DIR and /run/user/<uid> ${name}, enforcer() is watchdog`, { skip: process.platform !== 'linux' && 'Linux only' }, t => {
  if (!bwrapWorks()) return t.skip('bwrap cannot run here, so /run/user cannot be replaced for this process');
  if (name.startsWith('ours') && !managerAt(RUNTIME)) return t.skip(NO_MANAGER);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-runtime-'));
  try {
    const args = setup(d);
    if (!args) return t.skip('no root-owned directory to stand in for another user\'s');
    assert.equal(pickIn(args), 'watchdog');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

for (const how of hows) test(`eng run --by: a command that traps TERM and exits 0 after its timeout is recorded as a failure (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const by = `trap-${how}`;
  const r = eng(['run', '--by', by, '--budget', 'memory=128M workers=1 timeout=1s', '--', 'bash', '-c', 'trap "exit 0" TERM; sleep 10 & wait'], { ENG_BUDGET_ENFORCER: how });
  t.diagnostic(out(r));
  assert.match(r.stderr, /stopped by its budget: timeout 1s/);
  assert.notEqual(r.status, 0, out(r));
  assert.doesNotMatch(r.stdout, /\(exit 0\) as verdict evidence/);
  const rec = runsBy(by).at(-1);
  assert.ok(rec && rec.exit !== 0, `the run log records a failure: ${JSON.stringify(rec)}`);
});

// A parent that starts a detached worker (its own session, stdio ignored), writes its pid and exits 0 at once. The worker
// takes 32 MB every 30 ms up to 640 MB, holds 3s, then exits by itself: bounded even if enforcement fails.
const WORKER = 'const a=[];let n=0;const t=setInterval(()=>{if(n<20){a.push(Buffer.alloc(32<<20,1));n++}else{clearInterval(t);setTimeout(()=>process.exit(0),3000)}},30)';
const detachScript = () => {
  const f = path.join(dir, '.git', 'detach.cjs');
  fs.writeFileSync(f, `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(WORKER)}],{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.env.PIDF,String(c.pid));c.unref();\n`);
  return f;
};
for (const how of hows) test(`a detached child over the budget fails the check after its parent exits 0 (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const pidf = path.join(dir, '.git', `orphan-${how}.pid`); fs.rmSync(pidf, { force: true });
  checks({ orphan: `#!/usr/bin/env bash\n# budget: memory=256M workers=1 timeout=60s\nnode ${JSON.stringify(detachScript())}\n` });
  try {
    const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: how, PIDF: pidf });
    t.diagnostic(out(r));
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /FAIL\s+check:orphan\s+eng: FAIL check orphan: stopped by its budget: memory 256 MB/);
    const pid = Number(fs.readFileSync(pidf, 'utf8'));
    assert.equal(alive(pid), false, 'the detached worker is gone when the gate returns');
    if (how === 'systemd') assert.equal(scopes('eng-check-orphan-*'), '', 'no scope is left, failed or running');
  } finally {
    try { process.kill(Number(fs.readFileSync(pidf, 'utf8')), 'SIGKILL'); } catch {}
    if (systemd) dropScopes('eng-check-orphan-*');
  }
});

test('a light stage that deferred a heavy check is not verdict evidence: eng verdict PASS refuses it', () => {
  checks({ light: '#!/bin/sh\nexit 0\n', model: '#!/bin/sh\n# weight: heavy\n# budget: memory=256M workers=1\nexit 1\n' });
  const by = 'deferred-probe';
  let r = eng(['run', '--by', by, '--', process.execPath, ENG, 'gate', 'checks']);
  assert.equal(r.status, 3, out(r));
  assert.match(r.stdout, /deferred\s+check:model/);
  assert.equal(runsBy(by).at(-1).exit, 3, `the run records the incomplete gate: ${JSON.stringify(runsBy(by).at(-1))}`);
  r = eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(r.status, 0, out(r));
  assert.match(out(r), /exited 3/);
  r = eng(['run', '--by', by, '--', process.execPath, ENG, 'gate', 'checks', '--heavy']);
  assert.notEqual(r.status, 0, 'run in full, the heavy check fails the gate');
});

for (const how of hows) test(`SIGINT to eng gate with an inherited ENG_TMP leaves no check process or scope (${how} path)`, async t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const pidf = path.join(dir, '.git', `sigint-${how}.pid`); fs.rmSync(pidf, { force: true });
  checks({ wait: `#!/usr/bin/env bash\n# budget: memory=128M workers=1 timeout=60s\necho $$ > "$PIDF"\nexec sleep 30\n` });
  const inherited = fs.mkdtempSync(path.join(dir, '.git', 'inherited-'));
  const env = { ...process.env, ENG_BUDGET_ENFORCER: how, PIDF: pidf, ENG_TMP: inherited }; delete env.CI;
  const { spawn } = await import('node:child_process');
  const g = spawn(process.execPath, [ENG, 'gate', 'checks'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; g.stdout.on('data', d => { text += d; }); g.stderr.on('data', d => { text += d; });
  const exited = new Promise(r => g.on('exit', (code, signal) => r({ code, signal })));
  try {
    for (let i = 0; i < 200 && !(fs.existsSync(pidf) && fs.readFileSync(pidf, 'utf8').trim()); i++) await new Promise(r => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(pidf, 'utf8'));
    assert.ok(alive(pid), 'the check is running');
    g.kill('SIGINT');
    const e = await exited;
    t.diagnostic(text);
    assert.equal(e.code, 130, `eng gate exits 128+2: ${JSON.stringify(e)}`);
    assert.equal(alive(pid), false, 'the check process is gone');
    if (how === 'systemd') assert.equal(scopes(`eng-check-wait-${g.pid}-*`), '', 'no scope is left');
  } finally {
    g.kill('SIGKILL');
    try { process.kill(Number(fs.readFileSync(pidf, 'utf8')), 'SIGKILL'); } catch {}
    if (systemd) dropScopes(`eng-check-wait-${g.pid}-*`);
  }
});

test('eng lint accepts a JVM bound exported earlier in the same script, and still flags an unbounded call', () => {
  const lint = body => { checks({ model: `#!/usr/bin/env bash\n# weight: heavy\n${body}\n` }); return eng(['lint']); };
  for (const ok of ['export JAVA_TOOL_OPTIONS="-Xmx128m"\njava -version', 'JDK_JAVA_OPTIONS=-Xmx768m\njava -jar tla2tools.jar Spec.tla', 'export JAVA_OPTS=-Xmx768m\njava $JAVA_OPTS -jar tla2tools.jar', 'export JVM_ARGS="-Xmx1g"\napalache-mc check Spec.tla']) {
    const r = lint(ok); assert.equal(r.status, 0, `${ok}\n${out(r)}`);
  }
  for (const bad of ['java -jar tla2tools.jar Spec.tla', 'java -version\nexport JAVA_TOOL_OPTIONS=-Xmx128m', 'export JAVA_OPTS=-Xmx768m\njava -jar tla2tools.jar', '# export JAVA_TOOL_OPTIONS=-Xmx128m\njava -version', 'export JAVA_TOOL_OPTIONS=-Dfoo=1\njava -version']) {
    const r = lint(bad); assert.equal(r.status, 1, `${bad}\n${out(r)}`); assert.match(r.stderr, /\[heavy-tool-unbounded\]/);
  }
});

test('checks run one after another unless verification.parallel is true; in parallel they still wait for their budgets to fit', () => {
  const times = path.join(dir, '.git', 'times-seq'), cfgFile = path.join(dir, 'eng.config.yml'), orig = fs.readFileSync(cfgFile, 'utf8');
  try {
    checks({ a: timed('a', 300), b: timed('b', 300) });
    fs.rmSync(times, { force: true });
    let r = eng(['gate', 'checks', '--heavy'], { ENG_BUDGET_FREE_MB: '1000', TIMES: times });
    assert.equal(r.status, 0, out(r));
    let [a, b] = spans(times, ['a', 'b']);
    assert.ok(b[0] >= a[1], `an upgraded config (no verification.parallel) runs b after a: ${JSON.stringify({ a, b })}`);
    const c = YAML.parse(orig); c.verification.parallel = true; fs.writeFileSync(cfgFile, YAML.stringify(c)); git('commit -qam parallel');
    fs.rmSync(times, { force: true });
    r = eng(['gate', 'checks', '--heavy'], { ENG_BUDGET_FREE_MB: '1000', TIMES: times });
    assert.equal(r.status, 0, out(r));
    [a, b] = spans(times, ['a', 'b']);
    assert.ok(b[0] < a[1], `parallel: true runs two that fit side by side: ${JSON.stringify({ a, b })}`);
    checks({ a: timed('a', 600), b: timed('b', 600) });
    fs.rmSync(times, { force: true });
    r = eng(['gate', 'checks', '--heavy'], { ENG_BUDGET_FREE_MB: '1000', TIMES: times });
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /wait\s+check:b: its budget/);
    [a, b] = spans(times, ['a', 'b']);
    assert.ok(b[0] >= a[1], `parallel: true still waits when the budgets do not fit: ${JSON.stringify({ a, b })}`);
    c.verification.parallel = 'yes'; fs.writeFileSync(cfgFile, YAML.stringify(c));
    r = eng(['gate', 'checks']); assert.equal(r.status, 1, out(r)); assert.match(out(r), /verification\.parallel must be true, false or a whole number/);
  } finally { fs.writeFileSync(cfgFile, orig); git('commit -qam unparallel --allow-empty'); }
});

const DEFERRING = { light: '#!/bin/sh\nexit 0\n', model: '#!/bin/sh\n# weight: heavy\n# budget: memory=128M workers=1 timeout=5s\nexit 37\n' };
// ---------- verdict findings on 8657413 (PR 50, round 2): a nested eng run keeps its deferrals; env -i does not leave the
// watchdog ----------
for (const inner of [[], ['--by', 'nested-inner']]) test(`a nested eng run ${inner.length ? 'with' : 'without'} --by passes the inner gate's incomplete exit to the outer record`, () => {
  checks(DEFERRING);
  const by = `nested-outer-${inner.length}`;
  let r = eng(['run', '--by', by, '--', process.execPath, ENG, 'run', ...inner, '--', process.execPath, ENG, 'gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 3, out(r));
  assert.match(r.stdout, /deferred\s+check:model/);
  assert.equal(runsBy(by).at(-1).exit, 3, `the outer record says the run was incomplete: ${JSON.stringify(runsBy(by).at(-1))}`);
  if (inner.length) assert.equal(runsBy('nested-inner').at(-1).exit, 3, 'the inner record says so too');
  r = eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(r.status, 0, out(r));
  assert.match(out(r), /exited 3/);
});

// The allocator takes 32 MB every 40 ms up to 640 MB, holds 1s, then exits 0 by itself.
const SANE = 'const a=[];let n=0;const t=setInterval(()=>{if(n<20){a.push(Buffer.alloc(32<<20,1));n++}else{clearInterval(t);setTimeout(()=>process.exit(0),1000)}},40)';
for (const how of hows) for (const [name, argv] of [['an env -i leader', ['/usr/bin/env', '-i', process.execPath, '-e', SANE]], ['an env -i child of a shell', ['sh', '-c', '"$0" -i "$1" -e "$2"; exit 0', '/usr/bin/env', process.execPath, SANE]]]) test(`${name} over its budget is stopped (${how} path)`, async t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const { runBounded } = await import('../lib/budget.mjs');
  const r = await runBounded(argv, { memoryMb: 256, workers: 1, timeoutS: 20 }, { how, label: 'env-probe' }).result;
  t.diagnostic(JSON.stringify(r));
  assert.equal(r.stopped, 'memory', `the budget stopped it: ${JSON.stringify(r)}`);
  assert.notEqual(r.status, 0);
  assert.match(r.why, /memory 256 MB/);
});
test('a check that runs its allocator under env -i fails the gate on the watchdog path', () => {
  checks({ clean: `#!/bin/sh\n# budget: memory=256M workers=1 timeout=20s\nexec /usr/bin/env -i ${process.execPath} -e '${SANE}'\n` });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /FAIL\s+check:clean\s+eng: FAIL check clean: stopped by its budget: memory 256 MB/);
});

// ---------- verdict finding on 771c7ea (PR 50, round 3): a gate under env -i lost its deferral and counted as a pass.
// A gate that deferred a check exits 3 (incomplete), so every caller sees it, whatever environment the gate had. ----------
const CLEAN_GATE = ['/usr/bin/env', '-i', `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`, 'ENG_BUDGET_ENFORCER=watchdog', process.execPath, ENG, 'gate', 'checks'];
for (const nested of [false, true]) test(`a gate under env -i that deferred a failing heavy check is not a pass for the ${nested ? 'nested' : 'direct'} enclosing eng run --by`, async () => {
  checks(DEFERRING);
  const by = `env-i-${nested ? 'nested' : 'direct'}`;
  const r = eng(['run', '--by', by, '--', ...(nested ? [process.execPath, ENG, 'run', '--'] : []), ...CLEAN_GATE], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.match(r.stdout, /deferred\s+check:model/, out(r));
  assert.equal(r.status, 3, `the enclosing run exits with the gate's incomplete code: ${out(r)}`);
  const rec = runsBy(by).at(-1);
  const { passProblem } = await import('../lib/verification.mjs');
  assert.ok(passProblem({ method: 'verification', sha: rec.sha, runs: [rec] }, ['lib/x.mjs']), `the record cannot back a PASS: ${JSON.stringify(rec)}`);
  const v = eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(v.status, 0, out(v));
});
// ---------- verdict finding on f1b160f (PR 50, round 4): a check ran an inner gate through `| cat`, so the inner exit 3
// was lost and the outer gate passed. A check is a leaf (eng lint), and an inner gate that defers tells the gates and runs
// that enclose it out of band (lib/nested.mjs), so the outer one is incomplete whatever the pipeline did. ----------
const PIPED = pre => `#!/bin/sh\n${pre}${process.execPath} ${ENG} gate check:model | cat\n`;
for (const how of hows) for (const [name, pre] of [['through | cat', ''], ['under env -i and through | cat', `/usr/bin/env -i PATH=${process.env.PATH} HOME=${process.env.HOME} `]]) test(`a check that runs a deferring gate ${name} makes the outer gate exit 3, and its record cannot back a PASS (${how} path)`, async t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  checks({ ...DEFERRING, wrapper: PIPED(pre) });
  const by = `piped-${how}-${pre ? 'env' : 'plain'}`;
  const r = eng(['run', '--by', by, '--', process.execPath, ENG, 'gate', 'check:wrapper'], { ENG_BUDGET_ENFORCER: how });
  assert.equal(r.status, 3, out(r));
  assert.match(r.stdout, /INCOMPLETE\s+check:wrapper\s+eng: INCOMPLETE check:wrapper: a gate inside it ended incomplete \(exit 3\)/);
  assert.doesNotMatch(r.stdout, /eng gate: PASS/);
  const rec = runsBy(by).at(-1);
  assert.equal(rec.exit, 3, JSON.stringify(rec));
  const { passProblem } = await import('../lib/verification.mjs');
  assert.ok(passProblem({ method: 'verification', sha: rec.sha, runs: [rec] }, ['lib/x.mjs']));
  const v = eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(v.status, 0, out(v)); assert.match(out(v), /exited 3/);
});
for (const how of hows) test(`a deferring gate that a check leaves running after its parent exits still makes the outer gate exit 3 (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  checks({ ...DEFERRING, orphan: `#!/bin/sh\n( setsid sh -c "sleep 0.3; ${process.execPath} ${ENG} gate check:model | cat" </dev/null >/dev/null 2>&1 & )\nsleep 2\n` });
  const r = eng(['gate', 'check:orphan'], { ENG_BUDGET_ENFORCER: how });
  assert.equal(r.status, 3, out(r));
  assert.match(r.stdout, /INCOMPLETE\s+check:orphan/);
});
test('eng run --by around a deferring gate piped through cat records exit 3', () => {
  checks(DEFERRING);
  const r = eng(['run', '--by', 'piped-run', '--', 'sh', '-c', `${process.execPath} ${ENG} gate checks | cat`], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 3, out(r));
  assert.match(r.stderr, /eng run: INCOMPLETE \(exit 3\): a gate inside the command ended incomplete \(exit 3\)/);
  assert.equal(runsBy('piped-run').at(-1).exit, 3);
});
// ---------- verdict finding on ccc07e8 (PR 50, round 10): `eng run --by x -- eng run test` ended INCOMPLETE after 364 green
// tests. `eng run test` runs the suite in bwrap, whose user namespace cannot read the outer run's /proc/<pid>/cwd, and a
// fixture repo's deferring gate signalled the listener it could not place. A gate with no repository did the same. A
// deferral in repository B never reaches a listener in repository A. ----------
const FIXTURE_SUITE = `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [eng, cfg] = process.argv.slice(2), sh = (cmd, cwd) => spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, CI: '' } });
const repo = (dir, git) => { fs.mkdirSync(dir + '/.eng/checks', { recursive: true }); fs.copyFileSync(cfg, dir + '/eng.config.yml');
  fs.writeFileSync(dir + '/.eng/checks/model.sh', ${JSON.stringify(DEFERRING.model)}, { mode: 0o755 }); if (git) sh('git init -q -b main', dir); return dir; };
const b = repo(fs.mkdtempSync(process.env.TMPDIR + '/fixture-b-'), true), none = repo(fs.mkdtempSync('/tmp/eng-no-repo-'), false);
const gate = \`\${process.execPath} \${eng} gate check:model\`, sandbox = spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true']).status === 0;
const runs = [['b direct', gate + '; echo exit=$?', b], ['b piped', gate + ' | cat; echo piped', b], ['no repository, piped', gate + ' | cat; echo piped', none]];
if (sandbox) runs.push(['b in bwrap, piped', \`bwrap --dev-bind / / -- sh -c '\${gate} | cat'; echo piped\`, b]);
for (const [name, cmd, cwd] of runs) { const r = sh(cmd, cwd); console.log(\`fixture \${name}: \${/deferred\\s+check:model/.test(r.stdout) ? 'deferred' : 'NOT DEFERRED'} \${r.stdout.trim().split('\\n').at(-1)}\`); }
for (const d of [b, none]) fs.rmSync(d, { recursive: true, force: true });
`;
for (const how of hows) test(`a test suite's fixture gates that defer in another repository, or in none, leave eng run --by on this one at exit 0 (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  checks({ light: DEFERRING.light });
  const suite = path.join(dir, '..', `fixture-suite-${how}.mjs`); fs.writeFileSync(suite, FIXTURE_SUITE); t.after(() => fs.rmSync(suite, { force: true }));
  const by = `fixture-suite-${how}`;
  const r = eng(['run', '--by', by, '--budget', 'memory=512M workers=1 timeout=60s', '--', process.execPath, suite, ENG, path.join(dir, 'eng.config.yml')], { ENG_BUDGET_ENFORCER: how });
  t.diagnostic(r.stdout);
  for (const line of ['b direct: deferred exit=3', 'b piped: deferred piped', 'no repository, piped: deferred piped']) assert.ok(r.stdout.includes(`fixture ${line}`), `the fixture gate ran and deferred: ${out(r)}`);
  assert.doesNotMatch(r.stdout, /NOT DEFERRED/);
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(r.stderr, /INCOMPLETE/);
  assert.equal(runsBy(by).at(-1).exit, 0, JSON.stringify(runsBy(by).at(-1)));
});
test('a deferring gate in another process tree does not mark a gate that is running', async () => {
  checks({ ...DEFERRING, slow: '#!/bin/sh\nsleep 2\n' });
  const { spawn } = await import('node:child_process');
  const a = spawn(process.execPath, [ENG, 'gate', 'check:slow'], { cwd: dir, env: { ...process.env, CI: '', ENG_BUDGET_ENFORCER: 'watchdog' } });
  let text = ''; a.stdout.on('data', d => { text += d; }); a.stderr.on('data', d => { text += d; });
  const code = new Promise(r => a.on('close', r));
  await new Promise(r => setTimeout(r, 700));
  const b = eng(['gate', 'check:model']);
  assert.equal(b.status, 3, out(b));
  assert.equal(await code, 0, text);
  assert.match(text, /eng gate: PASS/);
});
// ---------- verdict findings on 002fe6d (PR 50, round 5): the marker files. With no /run/user/<uid>, a symlink planted at
// /tmp/eng-gates-<uid> led eng to empty the directory it pointed at; a marker write that failed (ENOSPC) was swallowed, so
// `gate | cat` passed again. The channel is now a signal: eng touches no shared directory and writes nothing to report a
// nested deferral. Every eng process here loads a preload (NODE_OPTIONS reaches the inner gate) that logs each shared-dir
// path it sees. The symlink trap hides /run/user/<uid> and maps /tmp/eng-gates-<uid> to a symlink to a private 0700
// directory holding a sentinel; the disk-full trap fails each marker write with ENOSPC, as the verdict's probe did. ----------
const SHARED = /^\/(tmp\/eng-gates-\d+|run\/user\/\d+\/eng-gates)(\/|$)/;
function sharedDirTrap(name, symlink) {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), `eng-r5-${name}-`)), victim = path.join(root, 'victim'), log = path.join(root, 'touched.log');
  fs.mkdirSync(victim, { mode: 0o700 }); fs.writeFileSync(path.join(victim, 'important-data'), 'synthetic sentinel');
  fs.symlinkSync(victim, path.join(root, 'eng-gates'));
  const preload = path.join(root, 'preload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const uid = process.getuid(), symlink = ${symlink}, fallback = ${JSON.stringify(path.join(path.sep, 'tmp', 'eng-gates-'))} + uid, to = ${JSON.stringify(path.join(root, 'eng-gates'))};
const append = fs.appendFileSync.bind(fs), log = ${JSON.stringify(log)};
const full = () => Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
for (const op of ['statSync', 'lstatSync', 'mkdirSync', 'readdirSync', 'rmSync', 'writeFileSync', 'readFileSync', 'openSync', 'appendFileSync', 'existsSync']) {
  const real = fs[op];
  fs[op] = function (p, ...a) {
    if (symlink && op === 'statSync' && p === '/run/user/' + uid) return undefined;
    if (typeof p === 'string' && ${SHARED}.test(p)) {
      append(log, op + ' ' + p + '\\n');
      if (symlink && p.startsWith(fallback)) p = to + p.slice(fallback.length);
      if (!symlink && op === 'writeFileSync' && /\\/[^/]+\\.\\d+$/.test(p)) throw full();
    }
    return real.call(fs, p, ...a);
  };
}
`);
  return { env: { NODE_OPTIONS: `--import ${preload}` }, victim, touched: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const TRAPS = [['a planted symlink', true], ['a full disk', false]];
for (const how of hows) for (const [trapName, symlink] of TRAPS) test(`a deferring gate inside a check, through | cat, makes the outer gate exit 3 with ${trapName}, and eng neither deletes nor writes anything for it (${how} path)`, t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  checks({ ...DEFERRING, wrapper: PIPED('') });
  const trap = sharedDirTrap(how, symlink);
  try {
    const r = eng(['gate', 'check:wrapper'], { ENG_BUDGET_ENFORCER: how, ...trap.env });
    t.diagnostic(out(r));
    assert.deepEqual(fs.readdirSync(trap.victim), ['important-data'], 'the directory the planted symlink points at keeps its contents');
    assert.doesNotMatch(r.stdout, /eng gate: PASS/);
    assert.equal(r.status, 3, `the outer gate is incomplete: ${out(r)}`);
    assert.match(r.stdout, /INCOMPLETE\s+check:wrapper/);
    assert.equal(trap.touched(), '', 'eng touched no shared marker directory');
  } finally { trap.done(); }
});
for (const [trapName, symlink] of TRAPS) test(`eng run --by around a deferring gate through | cat records exit 3 with ${trapName}`, async () => {
  checks(DEFERRING);
  const by = `r5-trap-${symlink}`, trap = sharedDirTrap('run', symlink);
  try {
    const r = eng(['run', '--by', by, '--', 'sh', '-c', `${process.execPath} ${ENG} gate checks | cat`], { ENG_BUDGET_ENFORCER: 'watchdog', ...trap.env });
    assert.deepEqual(fs.readdirSync(trap.victim), ['important-data']);
    assert.equal(r.status, 3, out(r));
    const rec = runsBy(by).at(-1);
    assert.equal(rec.exit, 3, JSON.stringify(rec));
    const { passProblem } = await import('../lib/verification.mjs');
    assert.ok(passProblem({ method: 'verification', sha: rec.sha, runs: [rec] }, ['lib/x.mjs']));
    assert.equal(trap.touched(), '');
  } finally { trap.done(); }
});
// ---------- verdict findings on 2ac7e01 (PR 50, round 6): a check whose PATH has no git could not confirm the enclosing
// run's repository, so `gate | cat` passed; a --here that belongs to the command made the enclosing eng run -- look like
// eng run --here; and a post-checkout hook's gate signalled eng run before it listened. ----------
const incompleteRecord = async (by, r) => {
  assert.equal(r.status, 3, out(r));
  const rec = runsBy(by).at(-1);
  assert.equal(rec.exit, 3, JSON.stringify(rec));
  const { passProblem } = await import('../lib/verification.mjs');
  assert.ok(passProblem({ method: 'verification', sha: rec.sha, runs: [rec] }, ['lib/x.mjs']));
};
const bashOnly = () => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-r6-path-')); fs.symlinkSync('/bin/bash', path.join(d, 'bash')); return d; };
for (const how of hows) test(`a deferring gate whose PATH has no git, through | cat, makes the enclosing run and gate exit 3 (${how} path)`, async t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  const tools = bashOnly();
  try {
    const inner = `ENG_BUDGET_ENFORCER=watchdog PATH=${tools} ${process.execPath} ${ENG} gate check:model | cat`;
    checks({ ...DEFERRING, wrapper: `#!/bin/sh\n${inner}\n` });
    await incompleteRecord(`r6-path-run-${how}`, eng(['run', '--by', `r6-path-run-${how}`, '--', 'sh', '-c', inner], { ENG_BUDGET_ENFORCER: how }));
    const r = eng(['run', '--by', `r6-path-check-${how}`, '--', process.execPath, ENG, 'gate', 'check:wrapper'], { ENG_BUDGET_ENFORCER: how });
    assert.doesNotMatch(r.stdout, /eng gate: PASS/);
    assert.match(r.stdout, /INCOMPLETE\s+check:wrapper/);
    await incompleteRecord(`r6-path-check-${how}`, r);
  } finally { fs.rmSync(tools, { recursive: true, force: true }); }
});
test('a --here after eng run -- belongs to the command: the enclosing run still hears a deferring gate', async () => {
  checks(DEFERRING);
  await incompleteRecord('r6-here', eng(['run', '--by', 'r6-here', '--', 'sh', '-c', `${process.execPath} ${ENG} gate checks | cat`, '--here'], { ENG_BUDGET_ENFORCER: 'watchdog' }));
});
test('a post-checkout hook whose gate defers while eng run makes its worktree makes the run exit 3', async () => {
  checks(DEFERRING);
  const hooks = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-r6-hooks-'));
  try {
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\n${process.execPath} ${ENG} gate checks 2>&1 | tee ${path.join(hooks, 'gate.log')}\n`, { mode: 0o755 });
    await incompleteRecord('r6-hook', eng(['run', '--by', 'r6-hook', '--', 'true'], { ENG_BUDGET_ENFORCER: 'watchdog', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks }));
    assert.match(fs.readFileSync(path.join(hooks, 'gate.log'), 'utf8'), /deferred\s+check:model[\s\S]*INCOMPLETE \(exit 3\)/, 'the hook\'s gate deferred');
  } finally { fs.rmSync(hooks, { recursive: true, force: true }); }
});
test('eng lint fails a check script that runs eng gate, and accepts one marked as a deliberate nested gate', () => {
  for (const bad of ['node ./bin/eng.mjs gate check:model | cat', '$eng gate', '"${ENG}" gate checks', 'npx eng gate --heavy', 'out=$(eng gate 2>&1)']) {
    checks({ wrapper: `#!/bin/sh\n${bad}\n` });
    const r = eng(['lint']); assert.equal(r.status, 1, `${bad}\n${out(r)}`); assert.match(r.stderr, /wrapper\.sh:2: \[check-runs-gate\] A check is a leaf/);
  }
  for (const ok of ['echo "eng gate passed"', '# eng gate in a comment', '$eng gate  # nested gate: the gate of a fixture repo is the subject under test', 'eng run --by x -- npm test']) {
    checks({ wrapper: `#!/bin/sh\n${ok}\n` });
    const r = eng(['lint']); assert.equal(r.status, 0, `${ok}\n${out(r)}`);
  }
});
test('eng gate exits 0 only when every selected check ran and passed; a deferred check makes it exit 3', () => {
  checks({ light: '#!/bin/sh\nexit 0\n', model: '#!/bin/sh\n# weight: heavy\n# budget: memory=128M workers=1 timeout=5s\nexit 0\n' });
  let r = eng(['gate', 'checks']);
  assert.equal(r.status, 3, out(r));
  assert.match(out(r), /INCOMPLETE/);
  assert.match(out(r), /light checks passed/);
  assert.match(out(r), /Deferred, not run: model/);
  assert.match(out(r), /eng gate --heavy/);
  r = eng(['gate', 'checks', '--heavy']);
  assert.equal(r.status, 0, out(r));
  r = eng(['gate', 'checks'], { CI: 'true' });
  assert.equal(r.status, 0, `CI runs heavy checks, so a passing CI gate exits 0: ${out(r)}`);
  checks({ light: '#!/bin/sh\nexit 0\n' });
  r = eng(['gate', 'checks']);
  assert.equal(r.status, 0, `a repo with no heavy checks never defers: ${out(r)}`);
});

// ---------- verdict finding on 80a069f (PR 50, round 7): an eng path that is only data to another program is not eng. A Node
// supervisor handed `eng.mjs gate` as arguments, with its own SIGURG handler, got the inner gate's signal and reported a
// failure of its own. eng now signals a process only when eng is the program itself: argv[0], or a JS runtime's entry
// script after the runtime's own options. ----------
// PR 50, round 10: `node eng gate` leaves 13 bytes of argv, so the old title `eng-listening gate` was cut to `eng-listening`
// and the enclosing gate missed the notice.
test('the shortest launch, node eng gate, shows the whole eng@gate title and gets the notice from a deferring inner gate', { skip: process.platform !== 'linux' && 'reads /proc' }, async t => {
  checks({ wrapper: `#!/bin/sh\nsleep 1\ncd sub && ${process.execPath} ${ENG} gate check:model | cat  # nested gate: the subject under test\n` });
  const c = YAML.parse(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8')); c.verification.checks_dir = '../.eng/heavy';
  fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'eng.config.yml'), YAML.stringify(c));
  fs.mkdirSync(path.join(dir, '.eng/heavy')); fs.writeFileSync(path.join(dir, '.eng/heavy', 'model.sh'), DEFERRING.model, { mode: 0o755 });
  fs.symlinkSync(ENG, path.join(dir, 'eng'));
  t.after(() => { for (const p of ['sub', '.eng/heavy', 'eng']) fs.rmSync(path.join(dir, p), { recursive: true, force: true }); });
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, ENG_BUDGET_ENFORCER: 'watchdog' }; delete env.CI;
  const g = spawn('node', ['eng', 'gate'], { cwd: dir, env });
  let text = ''; g.stdout.on('data', d => { text += d; }); g.stderr.on('data', d => { text += d; });
  const code = new Promise(r => g.on('close', r));
  let title = '';
  for (let i = 0; i < 100 && !title.startsWith('eng@'); i++) { await new Promise(r => setTimeout(r, 20)); try { title = fs.readFileSync(`/proc/${g.pid}/cmdline`, 'utf8').replace(/\0+$/, ''); } catch {} }
  assert.equal(title, 'eng@gate', `the whole title is in /proc/${g.pid}/cmdline`);
  assert.equal(await code, 3, text);
  assert.match(text, /INCOMPLETE\s+check:wrapper\s+eng: INCOMPLETE check:wrapper: a gate inside it ended incomplete/);
});
test('listens: only a process that named itself eng@gate or eng@run is a recipient, never one with eng in its arguments', async () => {
  const { listens } = await import('../lib/nested.mjs');
  const yes = [['eng@gate', '', ''], ['eng@run', '']];
  const no = [['node', '/p/bin/eng.mjs', 'gate'], ['node', '/x/supervisor.mjs', '/p/bin/eng.mjs', 'gate'], ['node', '--eval=0', '/p/eng.mjs', 'gate'], ['node', '-', '/p/eng.mjs', 'gate'], ['node', '--diagnostic-dir', '/p/eng.mjs', 'gate'], ['bun', '--cwd', '/p/eng.mjs', 'gate'], ['sh', '-c', 'eng@gate'], ['eng@lint'], ['eng@gate', 'x'], ['eng-listening gate'], []];
  for (const a of yes) assert.equal(listens(a), true, JSON.stringify(a));
  for (const a of no) assert.equal(listens(a), false, JSON.stringify(a));
});
for (const how of hows) test(`an unrelated program with eng's command as argument data is never signalled (${how} path)`, async t => {
  if (how === 'systemd' && !systemd) return t.skip(NO_SYSTEMD);
  checks(DEFERRING);
  const supDir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-r7-sup-'));
  t.after(() => fs.rmSync(supDir, { recursive: true, force: true }));
  const sup = path.join(supDir, 'supervisor.mjs');
  fs.writeFileSync(sup, `import { spawnSync } from 'node:child_process';
let urgent = 0; process.on('SIGURG', () => { urgent++; });
const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(ENG)}, 'gate', 'check:model'], { stdio: 'inherit' });
await new Promise(res => setTimeout(res, 200));
console.log('urgent=' + urgent + ' inner=' + r.status);
process.exit(urgent ? 1 : 0);
`);
  // The supervisor runs directly (not under eng run), carrying eng's path and `gate` as data arguments: as an entry script,
  // and as --eval code (round 8), where eng's path is only argv data to the inline program.
  const env = { ...process.env, CI: '', ENG_BUDGET_ENFORCER: how };
  const viaStdin = `await import(${JSON.stringify(sup)})`;
  for (const [argv, input] of [[[sup, ENG, 'gate']], [[`--eval=${viaStdin}`, '--input-type=module', ENG, 'gate']], [['--input-type=module', '-', ENG, 'gate'], viaStdin], [['--diagnostic-dir', ENG, sup, 'gate']]]) {
    const r = spawnSync(process.execPath, argv, { cwd: dir, encoding: 'utf8', env, input });
    assert.match(r.stdout, /urgent=0 inner=3/, `${JSON.stringify(argv)}\n${out(r)}`);
    assert.equal(r.status, 0, out(r));
  }
});
