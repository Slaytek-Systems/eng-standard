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
  else assert.match(r.stdout, /the process tree reached \d+ MB RSS/);
  if (how === 'systemd') assert.equal(spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', 'eng-check-hog-*'], { encoding: 'utf8' }).stdout.trim(), '', 'the transient scope is removed');
});

test('a check that runs past its timeout is stopped and fails, naming the budget', () => {
  checks({ slow: '#!/usr/bin/env bash\n# budget: timeout=1s\nsleep 30\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /eng: FAIL check slow: stopped by its budget: timeout 1s/);
});

test('a check with no budget runs under the default, and its tools get the matching flags', () => {
  checks({ plain: '#!/usr/bin/env bash\ngot="mem=$ENG_BUDGET_MEMORY_MB workers=$ENG_BUDGET_WORKERS java=$JAVA_TOOL_OPTIONS"\n[ "$got" = "mem=3072 workers=2 java=-Xmx2304m -XX:ActiveProcessorCount=2" ] || { echo "eng: FAIL check saw $got"; exit 1; }\n' });
  const r = eng(['gate', 'checks']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /start\s+check:plain \(light, default budget: memory 3072 MB, 2 workers, timeout 1800s\)/);
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
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /stage: light \(heavy checks run in CI, or here with eng gate --heavy\)/);
  assert.match(r.stdout, /deferred\s+check:model heavy check, not run in this stage/);
  assert.match(r.stdout, /eng gate: PASS \(light stage; 1 heavy check\(s\) deferred to CI or eng gate --heavy: model\)/);
  r = eng(['gate', 'checks', '--heavy']);
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /stage: light and heavy \(--heavy\)/); assert.match(r.stdout, /FAIL\s+check:model/);
  r = eng(['gate', 'checks'], { CI: 'true' });
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /stage: light and heavy \(CI\)/); assert.match(r.stdout, /FAIL\s+check:model/);
});

const spans = (file, ids) => { const l = fs.readFileSync(file, 'utf8').trim().split('\n').map(x => x.split(' ')); return ids.map(id => [Number(l.find(x => x[0] === id && x[1] === 'start')[2]), Number(l.find(x => x[0] === id && x[1] === 'end')[2])]); };
const timed = (id, mem) => `#!/usr/bin/env bash\n# weight: heavy\n# budget: memory=${mem}M workers=1 timeout=60s\necho "${id} start $(date +%s%N)" >> "$TIMES"; sleep 1; echo "${id} end $(date +%s%N)" >> "$TIMES"\n`;
test('two heavy checks whose budgets together exceed free memory run one after the other; two that fit run side by side', () => {
  const times = path.join(dir, '.git', 'times');
  checks({ a: timed('a', 600), b: timed('b', 600) });
  fs.rmSync(times, { force: true });
  let r = eng(['gate', 'checks', '--heavy'], { ENG_BUDGET_FREE_MB: '1000', TIMES: times });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /wait\s+check:b: its budget \(memory 600 MB, 1 worker, timeout 60s\) does not fit next to the 1 running \(1000 MB free at start/);
  let [a, b] = spans(times, ['a', 'b']);
  assert.ok(b[0] >= a[1], `b started after a ended: ${JSON.stringify({ a, b })}`);
  checks({ a: timed('a', 300), b: timed('b', 300) });
  fs.rmSync(times, { force: true });
  r = eng(['gate', 'checks', '--heavy'], { ENG_BUDGET_FREE_MB: '1000', TIMES: times });
  assert.equal(r.status, 0, out(r)); assert.doesNotMatch(r.stdout, /wait\s+check/);
  [a, b] = spans(times, ['a', 'b']);
  assert.ok(b[0] < a[1], `b started while a ran: ${JSON.stringify({ a, b })}`);
});

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
  assert.match(r.stdout, /budget: memory 3072 MB, 2 workers, timeout 1800s \(default; set one with --budget\)/);
  assert.match(r.stdout, /java saw JAVA_TOOL_OPTIONS=-Xmx2304m -XX:ActiveProcessorCount=2/);
  if (how === 'systemd') assert.match(r.stdout, /java cgroup memory\.max=3221225472/, 'the kernel limit is the budget');
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

// ---------- verdict findings on 02a7b0a (PR 50, GPT-family checker): a budget stop, a deferred check or a leftover process
// never counts as a pass ----------
const runLogFile = () => path.join(dir, '.git', 'eng', 'verdict-runs.jsonl');
const runsBy = by => fs.existsSync(runLogFile()) ? fs.readFileSync(runLogFile(), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.by === by) : [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const scopes = pattern => spawnSync('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', pattern], { encoding: 'utf8' }).stdout.trim();
const dropScopes = pattern => { for (const l of scopes(pattern).split('\n').filter(Boolean)) { const u = l.split(/\s+/)[0]; spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', u]); spawnSync('systemctl', ['--user', 'stop', u]); spawnSync('systemctl', ['--user', 'reset-failed', u]); } };
const hows = ['systemd', 'watchdog'];

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
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /deferred\s+check:model/);
  const rec = runsBy(by).at(-1);
  assert.deepEqual(rec.deferred, ['model'], `the run says what it deferred: ${JSON.stringify(rec)}`);
  r = eng(['verdict', 'PASS', '--by', by]);
  assert.notEqual(r.status, 0, out(r));
  assert.match(out(r), /deferred heavy check\(s\) model/);
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
    r = eng(['gate', 'checks']); assert.equal(r.status, 1, out(r)); assert.match(out(r), /verification\.parallel must be true or false/);
  } finally { fs.writeFileSync(cfgFile, orig); git('commit -qam unparallel --allow-empty'); }
});
