import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { once } from 'node:events';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-run-deps-'));
const dir = path.join(root, 'repo'), xdg = path.join(root, 'xdg');
const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_TMP: '', ENG_TMP_BASE: '', ENG_SCRATCH: '', ENG_NO_UPDATE_CHECK: '1' };
const eng = (a, e = env) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: e });
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const out = r => r.stdout + r.stderr;
const LOCK = '{"name":"r","lockfileVersion":3,"packages":{"node_modules/dep":{"version":"1.0.0"}}}\n';
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const usesDep = 'import("dep").then(m => console.log("dep says", m.default))';
// The deps reach the run through a fuse-overlayfs mount; without it the run gets none and eng says why. Only a real mount
// proves the host can: GitHub's runner has /dev/fuse and fuse-overlayfs, and refuses the mount (Operation not permitted).
const canMount = (PATH = process.env.PATH) => {
  const d = fs.mkdtempSync(path.join(root, 'probe-')), [lo, up, wk, mnt] = ['lo', 'up', 'wk', 'mnt'].map(n => path.join(d, n));
  for (const p of [lo, up, wk, mnt]) fs.mkdirSync(p);
  const ok = spawnSync('fuse-overlayfs', ['-o', `lowerdir=${lo},upperdir=${up},workdir=${wk}`, mnt], { env: { ...process.env, PATH }, stdio: 'ignore' }).status === 0;
  if (ok) spawnSync('fusermount3', ['-u', mnt]).status === 0 || spawnSync('fusermount', ['-u', mnt]);
  return ok;
};
const stub = (name, body) => { const bin = path.join(root, `bin-${name}`); fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'fuse-overlayfs'), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return `${bin}:${env.PATH}`; };
// Like GitHub's runner: the tool is installed and answers --version, and the mount is refused.
const REFUSED = '[ "$1" = --version ] && exit 0\necho "fuse-overlayfs: cannot mount: Operation not permitted" >&2\nexit 1';
const overlay = canMount();
const fallback = /eng run: no node_modules in the worktree \(.+\); a command that needs the dependencies installs them itself, e\.g\. eng run -- sh -c 'npm ci && npm test'/;
const tree = d => fs.readdirSync(d, { recursive: true }).sort().map(f => { const p = path.join(d, f), s = fs.lstatSync(p); return `${f} ${s.ino} ${(s.mode & 0o7777).toString(8)} ${s.isFile() ? fs.readFileSync(p, 'utf8') : ''}`; });
const restore = () => { git('reset -q --hard'); git('clean -qfdx -e node_modules -e packages/a/node_modules'); };

before(() => {
  fs.mkdirSync(dir);
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  put('.gitignore', 'node_modules/\n');
  put('package.json', '{"name":"r","type":"module","workspaces":["packages/a"],"dependencies":{"dep":"1.0.0"}}\n');
  put('package-lock.json', LOCK);
  put('packages/a/package.json', '{"name":"a","type":"module","dependencies":{"inner":"1.0.0"}}\n');
  put('packages/a/package-lock.json', LOCK.replaceAll('dep', 'inner'));
  git('add -A'); git('commit -qm base');
  for (const [m, word] of [['node_modules/dep', 'hi'], ['packages/a/node_modules/inner', 'inside']]) {
    put(`${m}/package.json`, `{"name":"${path.basename(m)}","version":"1.0.0","type":"module","exports":"./index.js"}\n`);
    put(`${m}/index.js`, `export default "${word}";\n`);
  }
  put('node_modules/.package-lock.json', LOCK);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('eng run: the command resolves the checkout\'s installed deps when the lockfile matches the commit', { skip: !overlay && 'fuse-overlayfs cannot mount here' }, () => {
  const r = eng(['run', '--by', 'v', '--', 'node', '-e', usesDep]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /dep says hi/);
  const runs = fs.readFileSync(path.join(dir, '.git', 'eng', 'verdict-runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(runs.at(-1).cmd, `node -e '${usesDep}'`, 'the recorded command is the one given, nothing added');
});

test('eng run: a workspace\'s own node_modules comes along too', { skip: !overlay && 'fuse-overlayfs cannot mount here' }, () => {
  const r = eng(['run', '--', 'sh', '-c', 'cd packages/a && node -e \'import("inner").then(m => console.log("inner says", m.default))\'']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /inner says inside/);
});

test('eng run: nothing the command does in node_modules reaches the checkout', { skip: !overlay && 'fuse-overlayfs cannot mount here' }, () => {
  const before = [tree(path.join(dir, 'node_modules')), tree(path.join(dir, 'packages/a/node_modules'))];
  const r = eng(['run', '--', 'sh', '-c', [
    'echo junk >> node_modules/dep/index.js', 'printf "{}" > node_modules/.package-lock.json', 'chmod 600 node_modules/dep/package.json',
    'echo junk >> packages/a/node_modules/inner/index.js', 'touch node_modules/new', 'rm -rf node_modules/dep', 'echo ran',
  ].join(' && ')]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /ran/);
  assert.deepEqual([tree(path.join(dir, 'node_modules')), tree(path.join(dir, 'packages/a/node_modules'))], before);
});

test('eng run: a run that ends leaves no mount behind', { skip: !overlay && 'fuse-overlayfs cannot mount here' }, () => {
  const r = eng(['run', '--', 'sh', '-c', 'pwd']);
  assert.equal(r.status, 0, out(r));
  const wt = r.stdout.trim().split('\n').find(l => l.startsWith('/'));
  assert.ok(wt && !fs.readFileSync('/proc/self/mountinfo', 'utf8').includes(wt), `still mounted under ${wt}`);
  assert.equal(fs.existsSync(wt), false);
});

for (const [name, change, cause] of [
  ['a root lockfile that differs from the commit\'s', () => put('package-lock.json', LOCK.replace('1.0.0', '2.0.0')), /package-lock\.json differs between the commit and /],
  ['a workspace lockfile that differs from the commit\'s', () => put('packages/a/package-lock.json', '{}\n'), /packages\/a\/package-lock\.json differs between the commit and /],
  ['a lockfile of another kind in the checkout only', () => put('yarn.lock', '# yarn\n'), /yarn\.lock is in .+ but not at the commit/],
  ['a lockfile the checkout lacks', () => fs.rmSync(path.join(dir, 'packages/a/package-lock.json')), /packages\/a\/package-lock\.json is at the commit but not in /],
])
  test(`eng run: ${name} gets no deps, and eng says which file and how to install them`, () => {
    change();
    try {
      const r = eng(['run', '--', 'node', '-e', usesDep]);
      assert.notEqual(r.status, 0, 'stale deps never stand in for the commit\'s');
      assert.match(out(r), fallback);
      assert.match(out(r), cause);
    } finally { restore(); }
  });

test('eng run: a checkout with no node_modules says so', () => {
  const nm = path.join(dir, 'node_modules'), aside = path.join(root, 'nm-aside'), inner = path.join(dir, 'packages/a/node_modules'), innerAside = path.join(root, 'inner-aside');
  fs.renameSync(nm, aside); fs.renameSync(inner, innerAside);
  try {
    const r = eng(['run', '--', 'true']);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), fallback);
    assert.match(out(r), /has no node_modules folder/);
  } finally { fs.renameSync(aside, nm); fs.renameSync(innerAside, inner); }
});

for (const [why, body, cause] of [
  ['the device is missing', 'echo "fuse: device not found" >&2\nexit 1', /fuse-overlayfs failed on node_modules: fuse: device not found/],
  ['the host refuses the mount (EPERM)', REFUSED, /fuse-overlayfs failed on node_modules: fuse-overlayfs: cannot mount: Operation not permitted/],
])
  test(`eng run: when the mount fails because ${why}, eng says why and the command still runs`, () => {
    const r = eng(['run', '--', 'sh', '-c', 'ls node_modules packages/a/node_modules 2>/dev/null; echo ran; echo "$ENG_SCRATCH" >&2'], { ...env, PATH: stub(why.split(' ')[1], body) });
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), fallback);
    assert.match(out(r), cause);
    assert.match(r.stdout, /^ran$/m);
    assert.doesNotMatch(r.stdout, /^(dep|inner)$/m, 'no partial node_modules reaches the command');
    const round = r.stderr.trim().split('\n').find(l => l.startsWith('/'));
    assert.ok(round && !fs.existsSync(round), `round ${round} is removed`);
    assert.doesNotMatch(fs.readFileSync('/proc/self/mountinfo', 'utf8'), new RegExp(round.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

test('the mount probe calls a host that refuses the mount unsupported, so the mount tests skip there', () => {
  assert.equal(canMount(stub('refused', REFUSED)), false);
});

test('eng run: a run whose eng was SIGKILLed leaves a mount, and the next run clears it', { skip: !overlay && 'fuse-overlayfs cannot mount here' }, async () => {
  const fifo = path.join(root, 'up.fifo');
  execSync(`mkfifo ${JSON.stringify(fifo)}`);
  const killed = spawn(process.execPath, [ENG, 'run', '--', 'sh', '-c', `echo "$$ $ENG_SCRATCH" > ${JSON.stringify(fifo)}; exec sleep 600`], { cwd: dir, env, stdio: 'ignore' });
  // The command says it is up through the FIFO; if eng ends first, the test opens the FIFO itself so the read ends.
  let read = false;
  const ended = once(killed, 'exit').then(() => { if (!read) fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); return ''; });
  const up = await Promise.race([fs.promises.readFile(fifo, 'utf8').then(t => { read = true; return t; }), ended]);
  assert.ok(up, 'eng ended before the command started');
  const [pid, round] = up.trim().split(' ');
  const mountsUnder = () => fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(l => l.includes(`${round}/`));
  assert.equal(mountsUnder().length, 2, 'the root and workspace node_modules are mounted while the command runs');
  killed.kill('SIGKILL'); await ended;
  try { process.kill(Number(pid), 'SIGKILL'); } catch {}
  assert.equal(mountsUnder().length, 2, 'a SIGKILLed eng runs no cleanup');
  try {
    const r = eng(['run', '--', 'true']);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stderr, new RegExp(`eng run: cleared .+ left by eng pid ${killed.pid}`));
    assert.deepEqual(mountsUnder(), []);
    assert.equal(fs.existsSync(round), false);
    assert.doesNotMatch(git('worktree list'), new RegExp(path.basename(round)));
  } finally { for (const l of mountsUnder()) spawnSync('fusermount3', ['-u', '-z', l.split(' ')[4]]); }
});
