import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-run-deps-'));
const dir = path.join(root, 'repo'), xdg = path.join(root, 'xdg');
const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_TMP: '', ENG_TMP_BASE: '', ENG_SCRATCH: '', ENG_NO_UPDATE_CHECK: '1' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const out = r => r.stdout + r.stderr;
const LOCK = '{"name":"r","lockfileVersion":3,"packages":{"node_modules/dep":{"version":"1.0.0"}}}\n';
const dep = path.join(dir, 'node_modules', 'dep');
const usesDep = 'import("dep").then(m => console.log("dep says", m.default))';

before(() => {
  fs.mkdirSync(dep, { recursive: true });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"r","type":"module","dependencies":{"dep":"1.0.0"}}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), LOCK);
  git('add -A'); git('commit -qm base');
  fs.writeFileSync(path.join(dep, 'package.json'), '{"name":"dep","version":"1.0.0","type":"module","exports":"./index.js"}\n');
  fs.writeFileSync(path.join(dep, 'index.js'), 'export default "hi";\n');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('eng run: the command resolves the checkout\'s installed deps when the lockfile matches the commit', () => {
  const r = eng('run', '--by', 'v', '--', 'node', '-e', usesDep);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /dep says hi/);
  const runs = fs.readFileSync(path.join(dir, '.git', 'eng', 'verdict-runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(runs.at(-1).cmd, `node -e '${usesDep}'`, 'the recorded command is the one given, nothing added');
});

test('eng run: an install, a new file or a removal in the run\'s node_modules never reaches the checkout', () => {
  const r = eng('run', '--', 'sh', '-c', 'echo x > n && mv n node_modules/dep/index.js && touch node_modules/new && rm -rf node_modules');
  assert.equal(r.status, 0, out(r));
  assert.equal(fs.readFileSync(path.join(dep, 'index.js'), 'utf8'), 'export default "hi";\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'node_modules')), ['dep']);
});

test('eng run: a lockfile that differs from the commit\'s gets no deps, and eng says how to install them', () => {
  fs.writeFileSync(path.join(dir, 'package-lock.json'), LOCK.replace('1.0.0', '2.0.0'));
  try {
    const r = eng('run', '--', 'node', '-e', usesDep);
    assert.notEqual(r.status, 0, 'stale deps never stand in for the commit\'s');
    assert.match(out(r), /package-lock\.json differs/);
    assert.match(out(r), /npm ci && /);
  } finally { git('checkout -- package-lock.json'); }
});
