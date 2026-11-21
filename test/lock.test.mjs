import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const env = { ...process.env, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', ENG_E2E_EVENT: '', GITHUB_BASE_REF: '', BUILDKITE_PULL_REQUEST_BASE_BRANCH: '', BUILDKITE_PULL_REQUEST_LABELS: '' };
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-lock-')); dirs.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  const file = p => path.join(dir, p);
  const read = p => fs.readFileSync(file(p), 'utf8');
  const edit = (p, f) => fs.writeFileSync(file(p), f(read(p)));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(TPL, file('eng.config.yml'));
  const s = eng('sync'); assert.equal(s.status, 0, s.stderr);
  git('add -A'); git('commit -qm base');
  return { dir, git, eng, file, read, edit };
}

test('two branches that each edit a managed file merge without a lock conflict, and sync --check passes after', () => {
  const r = repo();
  r.git('checkout -qb a');
  r.edit('AGENTS.md', s => s.replace('# AGENTS.md\n', '# AGENTS.md\n\nTeam A owns the deploy notes.\n'));
  assert.equal(r.eng('sync').status, 0); r.git('commit -qam a');
  r.git('checkout -q main'); r.git('checkout -qb b');
  r.edit('AGENTS.md', s => s + '\n## Team B\n\nTeam B owns the runbook.\n');
  assert.equal(r.eng('sync').status, 0); r.git('commit -qam b');
  const m = spawnSync('git', ['merge', '--no-edit', 'a'], { cwd: r.dir, encoding: 'utf8' });
  assert.equal(m.status, 0, `merge conflicted:\n${m.stdout}${m.stderr}`);
  assert.match(r.read('AGENTS.md'), /Team A owns the deploy notes[\s\S]*Team B owns the runbook/);
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stderr);
  const lock = r.read('.eng/lock.json');
  assert.match(r.eng('sync').stdout, /^eng sync: no changes\n$/m);
  assert.equal(r.read('.eng/lock.json'), lock);
});

test('the lock holds the standard version and sorted managed paths, with no content hashes', () => {
  const r = repo();
  const lock = JSON.parse(r.read('.eng/lock.json'));
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(lock.package, version);
  assert.ok(Array.isArray(lock.files) && lock.files.includes('AGENTS.md') && lock.files.includes('SHIPPING.md'));
  assert.deepEqual(lock.files, [...lock.files].sort());
  assert.deepEqual(Object.keys(lock).sort(), ['files', 'package'], 'the lock records no links (0.17.2)');
  assert.doesNotMatch(r.read('.eng/lock.json'), /[0-9a-f]{64}/);
});

test('eng sync on unchanged inputs leaves the lock byte-identical', () => {
  const r = repo();
  const lock = r.read('.eng/lock.json');
  const s = r.eng('sync');
  assert.match(s.stdout, /^eng sync: no changes\n$/m); assert.doesNotMatch(s.stdout, /wrote|removed/);
  assert.equal(r.read('.eng/lock.json'), lock);
});

test('a 0.17.1 lock that lists .claude/skills links is read fine; sync drops the field and leaves the links alone', () => {
  const r = repo();
  const now = JSON.parse(r.read('.eng/lock.json')), links = ['.claude/skills/grilling', '.claude/agents/poteto-agent.md'];
  fs.mkdirSync(r.file('.claude/skills'), { recursive: true }); fs.mkdirSync(r.file('.claude/agents'), { recursive: true });
  fs.symlinkSync('../../.agents/skills/grilling', r.file(links[0])); fs.symlinkSync('../../.agents/agents/poteto-agent.md', r.file(links[1]));
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify({ package: now.package, files: now.files, links: [...links].sort() }, null, 2) + '\n');
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stdout + d.stderr);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /wrote \.eng\/lock\.json/);
  assert.deepEqual(JSON.parse(r.read('.eng/lock.json')), { package: now.package, files: now.files });
  assert.equal(fs.readlinkSync(r.file(links[0])), '../../.agents/skills/grilling');
  assert.equal(fs.readlinkSync(r.file(links[1])), '../../.agents/agents/poteto-agent.md');
});

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
// Writes the lock as eng 0.11.0 did ({ path: sha256 } and a config_hash) for the paths sync manages now, plus extra.
function writeOldLock(r, extra = []) {
  const now = JSON.parse(r.read('.eng/lock.json')), paths = Array.isArray(now.files) ? now.files : Object.keys(now.files);
  const files = Object.fromEntries([...paths, ...extra].sort().map(p => [p, sha256(p)]));
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify({ config_hash: sha256(r.read('eng.config.yml')), package: '0.11.0', files }, null, 2) + '\n');
  return paths;
}

test('an old-format lock (path: sha256, config_hash) is read, then rewritten in the new format by eng sync', () => {
  const r = repo();
  const paths = writeOldLock(r, ['docs/OLD-RENDER.md']);
  fs.mkdirSync(r.file('docs')); fs.writeFileSync(r.file('docs/OLD-RENDER.md'), 'rendered by an older config\n');
  const d = r.eng('sync', '--check');
  assert.notEqual(d.status, 0, 'a path the old lock manages but the config no longer renders is drift');
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /removed docs\/OLD-RENDER\.md/);
  assert.ok(!fs.existsSync(r.file('docs/OLD-RENDER.md')));
  assert.match(s.stdout, /wrote \.eng\/lock\.json/);
  const lock = JSON.parse(r.read('.eng/lock.json'));
  assert.deepEqual(lock.files, paths);
  assert.ok(!('config_hash' in lock));
  assert.equal(r.eng('sync', '--check').status, 0);
});

test('an old-format lock that matches the config fails sync --check only on its version, until eng sync', () => {
  const r = repo();
  writeOldLock(r);
  const d = r.eng('sync', '--check');
  assert.equal(d.status, 1);
  assert.deepEqual(d.stderr.trim().split('\n').slice(1).map(l => l.trim()), [`.eng/lock.json: rendered by eng-standard 0.11.0, installed is ${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}. Fix: run eng sync and commit what it writes (docs/lifecycle.md, Upgrade)`]);
  assert.equal(r.eng('sync').status, 0);
  const ok = r.eng('sync', '--check'); assert.equal(ok.status, 0, ok.stderr);
});

test('sync --check still fails when the config changes what eng sync manages, until eng sync runs', () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: false', 'nightly: { enabled: true'));
  const d = r.eng('sync', '--check');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /\.eng\/ci\/e2e-nightly\.yml: missing/);
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
  assert.equal(r.eng('sync').status, 0);
  assert.equal(r.eng('sync', '--check').status, 0);
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: true', 'nightly: { enabled: false'));
  const stale = r.eng('sync', '--check');
  assert.notEqual(stale.status, 0, 'a rendered file the config dropped is drift until eng sync prunes it');
  assert.match(stale.stderr, /\.eng\/lock\.json: config changed since last sync/);
  assert.equal(r.eng('sync').status, 0);
  assert.ok(!fs.existsSync(r.file('.eng/ci/e2e-nightly.yml')));
  assert.equal(r.eng('sync', '--check').status, 0);
});

test('a skill listed twice (pstack/* and pstack/how) renders once, and sync --check passes after sync', () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace(/^( +)- pstack\/\*.*$/m, '$&\n$1- pstack/how'));
  assert.match(r.read('eng.config.yml'), /^ +- pstack\/how$/m);
  assert.equal(r.eng('sync').status, 0);
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stderr);
});

test('sync --check fails with no lock', () => {
  const r = repo();
  fs.rmSync(r.file('.eng/lock.json'));
  const d = r.eng('sync', '--check');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
});

// B-lock: eng sync deletes the lock entries it no longer renders, so a lock entry that is not a relative repo file path
// must be refused before sync, sync --check or init writes or deletes anything. {"files":"x"} read as ["0"] and deleted 0.
test('sync, sync --check and init refuse a lock whose files is not a list of relative repo paths, and change nothing', () => {
  const r = repo();
  fs.writeFileSync(r.file('0'), 'mine\n'); fs.mkdirSync(r.file('sub/.git'), { recursive: true }); fs.writeFileSync(r.file('sub/.git/config'), 'cfg\n');
  fs.rmSync(r.file('SHIPPING.md')); r.git('add -A'); r.git('commit -qm files');
  const cases = [
    ['{"package":"0.1.0","files":"x"}', /files must be a list of repo file paths/],
    ['{"package":"0.1.0","files":null}', /files must be a list of repo file paths/],
    ['{"package":"0.1.0"}', /files must be a list of repo file paths/],
    ['{"package":"0.1.0","files":{"0":false}}', /files must be a list of repo file paths/],
    ['{"package":"0.1.0","files":{"0":"x"}}', /files must be a list of repo file paths/],
    [`{"package":"0.1.0","files":{"../0":"${'a'.repeat(64)}"}}`, /"\.\.\/0" \(has a \. or \.\. segment\)/],
    ['{"package":"0.1.0","files":["0\\u0000x"]}', /\(has a NUL byte\)/],
    ['{"package":"0.1.0","files":[1]}', /1 \(not a string\)/],
    ['{"package":"0.1.0","files":[""]}', /"" \(empty\)/],
    [`{"package":"0.1.0","files":[${JSON.stringify(r.file('0'))}]}`, /\(absolute\)/],
    ['{"package":"0.1.0","files":["../x"]}', /"\.\.\/x" \(has a \. or \.\. segment\)/],
    ['{"package":"0.1.0","files":["./0"]}', /"\.\/0" \(has a \. or \.\. segment\)/],
    ['{"package":"0.1.0","files":["a//b"]}', /"a\/\/b" \(has an empty segment or a trailing slash\)/],
    ['{"package":"0.1.0","files":["sub/"]}', /"sub\/" \(has an empty segment or a trailing slash\)/],
    ['{"package":"0.1.0","files":["a\\\\b"]}', /\(has a backslash\)/],
    ['{"package":"0.1.0","files":[".git/HEAD"]}', /"\.git\/HEAD" \(has a \.git segment\)/],
    ['{"package":"0.1.0","files":["sub/.git/config"]}', /"sub\/\.git\/config" \(has a \.git segment\)/],
    ['{"package":"0.1.0","files":["sub/.GIT/config"]}', /\(has a \.git segment\)/],
    ['[]', /not a JSON object/],
    ['nope', /not valid JSON/],
  ];
  const state = () => [r.git('status --porcelain --untracked-files=all'), r.read('.eng/lock.json'), r.read('eng.config.yml'), r.read('0'), r.read('sub/.git/config')].join('\0');
  for (const [lock, why] of cases) {
    fs.writeFileSync(r.file('.eng/lock.json'), lock + '\n');
    const before = state();
    for (const cmd of [['sync'], ['sync', '--check'], ['init']]) {
      const d = r.eng(...cmd);
      assert.equal(d.status, 1, `eng ${cmd.join(' ')} with ${lock}: ${d.stdout}${d.stderr}`);
      assert.match(d.stderr, /^eng: FAIL \.eng\/lock\.json: /, `eng ${cmd.join(' ')} with ${lock}`);
      assert.match(d.stderr, why, `eng ${cmd.join(' ')} with ${lock}`);
      assert.match(d.stderr, /Fix: correct (each refused entry|\.eng\/lock\.json)/);
      assert.equal(d.stdout, '', `eng ${cmd.join(' ')} with ${lock} printed ${d.stdout}`);
      assert.equal(state(), before, `eng ${cmd.join(' ')} with ${lock} changed the repo`);
    }
  }
  r.git('checkout -q -- .eng/lock.json');
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.ok(fs.existsSync(r.file('SHIPPING.md')) && r.read('0') === 'mine\n');
});

test('the refusal names every bad entry, keeps good ones out of it, and is one fixed message', () => {
  const r = repo();
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify({ package: '0.1.0', files: ['AGENTS.md', '/etc/passwd', 'a/../b'] }));
  const d = r.eng('sync');
  assert.equal(d.status, 1);
  assert.equal(d.stderr, 'eng: FAIL .eng/lock.json: files lists 2 entries that are not relative repo file paths: "/etc/passwd" (absolute), "a/../b" (has a . or .. segment). Fix: correct each refused entry in .eng/lock.json, then run eng sync.\n');
});

test('with the update notice on, a bad lock is refused before the notice writes its cache', () => {
  const r = repo();
  fs.writeFileSync(r.file('package.json'), JSON.stringify({ name: 'demo', devDependencies: { '@slayteksystems/eng-standard': 'github:Slaytek-Systems/eng-standard#v0.18.2' } }));
  fs.writeFileSync(r.file('.eng/lock.json'), '{"package":"0.1.0","files":[false]}\n');
  const xdg = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-lock-xdg-')); dirs.push(xdg);
  const on = { ...env, XDG_CACHE_HOME: xdg, ENG_STANDARD_SOURCE: `file://${xdg}/no-such-source/` };
  for (const k of ['NODE_TEST_CONTEXT', 'CI', 'ENG_NO_UPDATE_CHECK']) delete on[k];
  for (const cmd of [['sync'], ['sync', '--check'], ['init']]) {
    const d = spawnSync(process.execPath, [ENG, ...cmd], { cwd: r.dir, encoding: 'utf8', env: on });
    assert.equal(d.status, 1, `eng ${cmd.join(' ')}: ${d.stderr}`);
    assert.match(d.stderr, /^eng: FAIL \.eng\/lock\.json: files lists 1 entry .*false \(not a string\)/);
    assert.deepEqual(fs.readdirSync(xdg), [], `eng ${cmd.join(' ')} wrote the update cache before refusing`);
  }
});

test('eng never locks a path it would refuse: skills_dir .claude syncs twice and passes sync --check; checks_dir ./ or / is a config error (0.23.10)', () => {
  const r = repo();
  r.edit('eng.config.yml', s => { assert.ok(s.includes('skills_dir: .agents/skills')); return s.replace('skills_dir: .agents/skills', 'skills_dir: .claude'); });
  for (const args of [['sync'], ['sync'], ['sync', '--check']]) { const d = r.eng(...args); assert.equal(d.status, 0, `eng ${args.join(' ')}: ${d.stderr}`); }
  const files = JSON.parse(r.read('.eng/lock.json')).files;
  assert.ok(files.includes('.eng/checks/.gitkeep'), files.filter(f => f.includes('checks')));
  assert.ok(files.includes('agents/poteto-agent.md'), files.filter(f => f.includes('agents/')).slice(0, 3));
  for (const to of ['checks_dir: ./.eng/checks', 'checks_dir: /.eng/checks']) {
    const q = repo(), lock = q.read('.eng/lock.json');
    q.edit('eng.config.yml', s => { assert.ok(s.includes('checks_dir: .eng/checks')); return s.replace('checks_dir: .eng/checks', to); });
    for (const args of [['sync'], ['sync', '--check']]) {
      const d = q.eng(...args);
      assert.equal(d.status, 1, `${to}: eng ${args.join(' ')}: ${d.stderr}`);
      assert.match(d.stderr, /config invalid/, `${to}: eng ${args.join(' ')}`);
      assert.equal(q.read('.eng/lock.json'), lock, `${to}: eng ${args.join(' ')} changed the lock`);
    }
  }
});

// Kalsigns 29c (Core task p574jfn0gsbbap66fxm6t1f17n8jnhrk): drift ends with one plain line that says what to do.
const OUT_OF_DATE = 'Generated eng files are out of date. Edit eng.config.yml if needed, then run eng sync and commit what it writes.';
const lastLine = r => r.stderr.trimEnd().split('\n').at(-1);

test('sync --check drift (a missing file, a differing file, a changed lock) ends with one line that says what to do', () => {
  const r = repo();
  fs.rmSync(r.file('SHIPPING.md'));
  let d = r.eng('sync', '--check');
  assert.equal(d.status, 1); assert.match(d.stderr, /^  SHIPPING\.md: missing$/m); assert.equal(lastLine(d), OUT_OF_DATE);
  assert.equal(d.stderr.split('\n').filter(l => l.includes('out of date')).length, 1, 'the line appears once');
  assert.equal(r.eng('sync').status, 0);
  r.edit('SHIPPING.md', s => s + 'hand edit\n');
  d = r.eng('sync', '--check');
  assert.equal(d.status, 1); assert.match(d.stderr, /^  SHIPPING\.md: differs from what eng\.config\.yml renders$/m); assert.equal(lastLine(d), OUT_OF_DATE);
  assert.equal(r.eng('sync').status, 0);
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: false', 'nightly: { enabled: true'));
  d = r.eng('sync', '--check');
  assert.equal(d.status, 1); assert.match(d.stderr, /^  \.eng\/lock\.json: config changed since last sync$/m); assert.equal(lastLine(d), OUT_OF_DATE);
});

test('sync --check drift in a repo that pins eng-standard names the pinned eng command', () => {
  const r = repo();
  fs.writeFileSync(r.file('package.json'), JSON.stringify({ name: 'adopter', devDependencies: { '@slayteksystems/eng-standard': 'github:Slaytek-Systems/eng-standard#v0.23.0' } }));
  fs.rmSync(r.file('SHIPPING.md'));
  const d = r.eng('sync', '--check');
  assert.equal(d.status, 1);
  assert.equal(lastLine(d), 'Generated eng files are out of date. Edit eng.config.yml if needed, then run the repo-pinned eng (node node_modules/@slayteksystems/eng-standard/bin/eng.mjs sync) and commit what it writes.');
});

test('sync --check refusals that are not drift do not get the out-of-date line', () => {
  const r = repo();
  writeOldLock(r); // matches the config; only its renderer version differs
  let d = r.eng('sync', '--check');
  assert.equal(d.status, 1); assert.doesNotMatch(d.stderr, /out of date/);
  assert.equal(r.eng('sync').status, 0);
  r.edit('eng.config.yml', s => s + 'gates: 7\n');
  d = r.eng('sync', '--check');
  assert.equal(d.status, 1); assert.doesNotMatch(d.stderr, /out of date/);
});
