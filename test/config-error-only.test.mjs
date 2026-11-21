// With an invalid eng.config.yml, the config invalid error is the only output (Core task p57axxw6rrd4bbb4fct32hce1n8jn6xy).
// A command that reads the config reads it first: no update notice, no doctor version line and no lint --config-from
// advisory print before the error, and the update notice writes no cache.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const PIN = JSON.stringify({ name: 'demo', devDependencies: { '@slayteksystems/eng-standard': 'github:Slaytek-Systems/eng-standard#v0.18.2' } });

// A committed repo that pins eng-standard, with the given eng.config.yml text, run with the update notice on and a newer
// release known (a local source at 99.0.0), so the notice and doctor's version line would both print.
function repo(config) {
  const dir = tmp('eng-cfg-only-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'package.json'), PIN);
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), config);
  git('add -A'); git('commit -qm base');
  const src = tmp('eng-src-'), xdg = tmp('eng-xdg-');
  fs.writeFileSync(path.join(src, 'package.json'), '{"version":"99.0.0"}');
  fs.writeFileSync(path.join(src, 'CHANGELOG.md'), '# Changelog\n');
  const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_STANDARD_SOURCE: src };
  for (const k of ['NODE_TEST_CONTEXT', 'CI', 'ENG_NO_UPDATE_CHECK', 'GITHUB_ACTIONS', 'BUILDKITE']) delete env[k];
  return { dir, xdg, eng: args => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env, timeout: 60_000 }) };
}

const INVALID = [
  ['a rule the config breaks', TPL.replace(/^version: 1$/m, 'version: 2'), /^eng: FAIL config invalid:\n {2}version must be 1$/m],
  ['YAML that does not parse', `${TPL}\nbroken: [\n`, /^eng: FAIL config invalid: eng\.config\.yml line \d+: the YAML does not parse$/m],
  ['a key given twice', `${TPL}\nversion: 1\n`, /^eng: FAIL config invalid: eng\.config\.yml line \d+: a key is given twice: "version"$/m],
];
// Every command whose first step is reading this checkout's eng.config.yml.
const COMMANDS = [
  ['lint'], ['lint', '--config-from', 'origin/main'], ['doctor'], ['doctor', '--launch', '--check-only'], ['gate'],
  ['e2e'], ['e2e', '--required'], ['e2e', '--flake-check', '--results', 'pass,pass'], ['rules', 'prove'],
  ['verdict', 'check'], ['verdict', 'PASS', '--by', 'probe'], ['merge', 'post', '--dry-run'], ['run', '--here', '--', 'true'], ['run', 'probe'],
];

for (const [what, config, error] of INVALID) {
  test(`with ${what}, the config invalid error is the only output and no update cache is written`, () => {
    assert.notEqual(config, TPL);
    for (const args of COMMANDS) {
      const r = repo(config), x = r.eng(args), name = `eng ${args.join(' ')}`;
      assert.equal(x.signal, null, `${name} did not hang`);
      assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
      assert.equal(x.stdout, '', `${name} printed nothing to stdout before the error`);
      assert.match(x.stderr, /^eng: FAIL config invalid/, `${name}: the error comes first: ${x.stderr}`);
      assert.match(x.stderr, error, `${name}: ${x.stderr}`);
      assert.doesNotMatch(x.stderr, /is available|eng-standard: installed|--config-from is ignored/, `${name}: ${x.stderr}`);
      assert.ok(x.stderr.split('\n').filter(Boolean).every((l, i) => i === 0 ? l.startsWith('eng: FAIL config invalid') : l.startsWith('  ')), `${name}: only the error: ${x.stderr}`);
      assert.deepEqual(fs.readdirSync(r.xdg), [], `${name} wrote the update cache before refusing`);
    }
  });
}

test('with a valid config, the update notice, doctor\'s version line and the lint advisory still print', () => {
  const r = repo(TPL);
  assert.equal(r.eng(['sync']).status, 0);
  execSync('git add -A && git commit -qm sync', { cwd: r.dir });
  const lint = r.eng(['lint', '--config-from', 'origin/main']);
  assert.match(lint.stderr, /^eng: eng-standard 99\.0\.0 is available/m, lint.stderr);
  assert.match(lint.stdout, /^ {2}--config-from is ignored since 0\.18\.2: lint uses this checkout's eng\.config\.yml\n/, lint.stdout);
  const doc = r.eng(['doctor']);
  assert.match(doc.stdout, /^ {2}WARN eng-standard: installed \S+, rendered \S+ \(\.eng\/lock\.json\), latest 99\.0\.0 /, doc.stdout);
  assert.doesNotMatch(doc.stderr, /is available/, 'doctor keeps its own version report');
});

// Review round 1 on #125.
test('eng verdict status without a numeric --pr is a usage error before any config, as before', () => {
  const r = repo(`${TPL}\nbroken: [\n`), x = r.eng(['verdict', 'status']);
  assert.equal(x.status, 1); assert.match(x.stderr, /^eng: FAIL usage: eng verdict status --pr <n>$/m);
  assert.doesNotMatch(x.stderr, /config invalid/);
});

test('with no eng.config.yml, doctor\'s version line and the lint advisory print first, as before', () => {
  const r = repo(TPL); fs.rmSync(path.join(r.dir, 'eng.config.yml'));
  const doc = r.eng(['doctor']);
  assert.match(doc.stdout, /^ {2}\S+ eng-standard: installed /, doc.stdout + doc.stderr); assert.match(doc.stderr, /no eng\.config\.yml/);
  const lint = r.eng(['lint', '--config-from', 'origin/main']);
  assert.match(lint.stdout, /^ {2}--config-from is ignored/, lint.stdout + lint.stderr); assert.match(lint.stderr, /no eng\.config\.yml/);
});

test('a YAML warning in a valid config prints where doctor loads it, after its version line, as before', async () => {
  const r = repo(`%YAML 1.3\n---\n${TPL}`), log = path.join(tmp('eng-log-'), 'out'), fd = fs.openSync(log, 'w');
  const srv = (await import('node:http')).createServer((req, res) => { res.writeHead(200, { connection: 'close' }); res.end(req.url.endsWith('package.json') ? '{"version":"99.0.0"}' : '# Changelog\n'); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: r.xdg, ENG_STANDARD_SOURCE: `http://127.0.0.1:${srv.address().port}/` };
    const { spawn } = await import('node:child_process');
    await new Promise(ok => spawn(process.execPath, [ENG, 'doctor'], { cwd: r.dir, env, stdio: ['ignore', fd, fd] }).on('close', ok));
  } finally { srv.close(); fs.closeSync(fd); }
  const both = fs.readFileSync(log, 'utf8'), v = both.search(/eng-standard: installed /), w = both.indexOf('YAMLWarning');
  assert.ok(v >= 0 && (w === -1 || w > v), `version line first; a warning, if any, after it: ${both.slice(0, 600)}`);
});

test('the command uses the config text dispatch checked, even if the file changes while the notice waits', async () => {
  const r = repo(TPL);
  assert.equal(r.eng(['sync']).status, 0); execSync('git add -A && git commit -qm sync', { cwd: r.dir });
  const srv = (await import('node:http')).createServer((req, res) => {
    fs.writeFileSync(path.join(r.dir, 'eng.config.yml'), `${TPL}\nbroken: [\n`); // saved mid-lookup
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end('{"version":"99.0.0"}');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: tmp('eng-xdg-'), ENG_STANDARD_SOURCE: `http://127.0.0.1:${srv.address().port}/` };
    for (const k of ['NODE_TEST_CONTEXT', 'CI', 'ENG_NO_UPDATE_CHECK', 'GITHUB_ACTIONS', 'BUILDKITE']) delete env[k];
    const { spawn } = await import('node:child_process');
    const [code, out, err] = await new Promise(ok => { let o = '', e = ''; const c = spawn(process.execPath, [ENG, 'lint'], { cwd: r.dir, env }); c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; }); c.on('close', s => ok([s, o, e])); });
    assert.match(fs.readFileSync(path.join(r.dir, 'eng.config.yml'), 'utf8'), /broken: \[/, 'the file did change during the lookup');
    assert.doesNotMatch(err, /config invalid/, err);
    assert.match(err, /is available/); assert.equal(code, 0, out + err); assert.match(out, /eng lint: PASS/);
  } finally { srv.close(); }
});

// Review round 2 on #125.
test('the YAML warning of a valid config still prints where the command loads it', () => {
  const r = repo(`%YAML 1.3\n---\n${TPL}`), x = r.eng(['lint']);
  assert.match(x.stderr, /YAMLWarning: Unsupported YAML version 1\.3/, x.stderr);
});

test('with no eng.config.yml at the start, one created while the notice waits is not read: the missing-config error stays', async () => {
  const r = repo(TPL); fs.rmSync(path.join(r.dir, 'eng.config.yml'));
  const srv = (await import('node:http')).createServer((req, res) => {
    fs.writeFileSync(path.join(r.dir, 'eng.config.yml'), `${TPL}\nbroken: [\n`); // created mid-lookup
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end('{"version":"99.0.0"}');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  try {
    const env = { ...process.env, XDG_CACHE_HOME: tmp('eng-xdg-'), ENG_STANDARD_SOURCE: `http://127.0.0.1:${srv.address().port}/` };
    for (const k of ['NODE_TEST_CONTEXT', 'CI', 'ENG_NO_UPDATE_CHECK', 'GITHUB_ACTIONS', 'BUILDKITE']) delete env[k];
    const { spawn } = await import('node:child_process');
    const [code, , err] = await new Promise(ok => { let o = '', e = ''; const c = spawn(process.execPath, [ENG, 'lint'], { cwd: r.dir, env }); c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; }); c.on('close', s => ok([s, o, e])); });
    assert.ok(fs.existsSync(path.join(r.dir, 'eng.config.yml')), 'the file was created during the lookup');
    assert.equal(code, 1); assert.match(err, /no eng\.config\.yml/, err); assert.doesNotMatch(err, /config invalid/, err);
  } finally { srv.close(); }
});

// eng run in a private worktree reads eng.config.yml too (Core task p5719k8k2sp8aww7vj2rx8ety18jnj8f): an invalid one is
// refused like every other command's, before the update notice, and nothing starts: no worktree, no scratch folder, no command.
test('eng run in a private worktree refuses an invalid eng.config.yml with only the error, and starts nothing', () => {
  for (const [what, config, error] of INVALID) {
    for (const args of [['run', '--', 'true'], ['run', '--by', 'probe', '--', 'true'], ['run', '--keep'], ['run', '--ref', 'HEAD', '--', 'true']]) {
      const r = repo(config), x = r.eng(args), name = `${what}: eng ${args.join(' ')}`;
      assert.equal(x.signal, null, `${name} did not hang`);
      assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
      assert.equal(x.stdout, '', `${name} printed nothing to stdout`);
      assert.match(x.stderr, error, `${name}: ${x.stderr}`);
      assert.ok(x.stderr.split('\n').filter(Boolean).every((l, i) => i === 0 ? l.startsWith('eng: FAIL config invalid') : l.startsWith('  ')), `${name}: only the error: ${x.stderr}`);
      assert.deepEqual(fs.readdirSync(r.xdg), [], `${name} wrote nothing under XDG_CACHE_HOME (no update cache, no scratch round)`);
    }
    const r = repo(config), mark = path.join(tmp('eng-mark-'), 'started');
    const x = r.eng(['run', '--', 'sh', '-c', `touch '${mark}'`]);
    assert.equal(x.status, 1, x.stdout + x.stderr);
    assert.ok(!fs.existsSync(mark), `${what}: the command never started`);
    assert.equal(execSync('git worktree list --porcelain', { cwd: r.dir, encoding: 'utf8' }).match(/^worktree /gm).length, 1, `${what}: no worktree was added`);
  }
});

test('eng run in a private worktree still runs with no eng.config.yml, and with a valid one', () => {
  for (const config of [null, TPL]) {
    const r = repo(TPL), mark = path.join(tmp('eng-mark-'), 'started');
    if (config === null) { fs.rmSync(path.join(r.dir, 'eng.config.yml')); execSync('git commit -qam "no config"', { cwd: r.dir }); }
    const x = r.eng(['run', '--', 'sh', '-c', `touch '${mark}'`]);
    assert.equal(x.status, 0, `${config === null ? 'no config' : 'valid config'}: ${x.stdout}${x.stderr}`);
    assert.ok(fs.existsSync(mark), 'the command ran');
    assert.doesNotMatch(x.stderr, /config invalid|no eng\.config\.yml/, x.stderr);
  }
});

// Review round 1 on #126: a value of the wrong type in a list the shared validator walks is a config error, not a stack trace.
test('a wrong-typed constraints.rules or stack.exceptions is one config invalid error, for eng run and eng lint alike', async () => {
  const YAML = (await import('yaml')).default;
  const shaped = f => { const c = YAML.parse(TPL); f(c); return YAML.stringify(c); };
  const cases = [
    ['constraints.rules a mapping', shaped(c => { c.constraints = { ...(c.constraints || {}), rules: {} }; }), /^ {2}constraints\.rules must be a list of rules$/m],
    ['constraints.rules holding null', shaped(c => { c.constraints = { ...(c.constraints || {}), rules: [null] }; }), /^ {2}constraints\.rules must be a list of rules$/m],
    ['stack.exceptions a number', shaped(c => { c.stack = { ...(c.stack || {}), exceptions: 5 }; }), /^ {2}stack\.exceptions must be a list of exceptions$/m],
  ];
  for (const [what, config, detail] of cases) for (const args of [['run', '--', 'true'], ['lint']]) {
    const r = repo(config), x = r.eng(args), name = `${what}: eng ${args.join(' ')}`;
    assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
    assert.equal(x.stdout, '', name);
    assert.match(x.stderr, /^eng: FAIL config invalid:\n/, `${name}: ${x.stderr}`);
    assert.match(x.stderr, detail, `${name}: ${x.stderr}`);
    assert.ok(x.stderr.split('\n').filter(Boolean).every((l, i) => i === 0 ? l.startsWith('eng: FAIL config invalid') : l.startsWith('  ')), `${name}: only the error: ${x.stderr}`);
    assert.deepEqual(fs.readdirSync(r.xdg), [], `${name} wrote nothing under XDG_CACHE_HOME`);
  }
});

// Review round 2 on #126: a rule id or exception name that is not a string is named by its place in the list.
test('a constraints rule or stack exception with a mapping for its id or name is one config invalid error', async () => {
  const YAML = (await import('yaml')).default;
  const shaped = f => { const c = YAML.parse(TPL); f(c); return YAML.stringify(c); };
  const cases = [
    ['a rule id', shaped(c => { c.constraints = { ...(c.constraints || {}), rules: [{ id: { toString: null } }] }; }), /^ {2}constraints\.rules\[0\] needs proven_by\.incident and proven_by\.fixture$/m],
    ['an exception name', shaped(c => { c.stack = { ...(c.stack || {}), exceptions: [{ name: { toString: null } }] }; }), /^ {2}stack\.exceptions\[0\] needs a reason$/m],
  ];
  for (const [what, config, detail] of cases) for (const args of [['run', '--', 'true'], ['lint']]) {
    const r = repo(config), x = r.eng(args), name = `${what}: eng ${args.join(' ')}`;
    assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
    assert.equal(x.stdout, '', name);
    assert.match(x.stderr, detail, `${name}: ${x.stderr}`);
    assert.ok(x.stderr.split('\n').filter(Boolean).every((l, i) => i === 0 ? l.startsWith('eng: FAIL config invalid') : l.startsWith('  ')), `${name}: only the error: ${x.stderr}`);
    assert.deepEqual(fs.readdirSync(r.xdg), [], `${name} wrote nothing under XDG_CACHE_HOME`);
  }
});
