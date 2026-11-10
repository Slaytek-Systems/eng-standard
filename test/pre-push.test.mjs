// hooks.pre_push (0.17.0; Kalsigns escalation, 9 Nov 2026): a repo's own pre-push rules run after eng's checks, with the
// hook's arguments and the same ref lines on stdin. Every push here is a real `git push` to a bare remote through the
// hook that `eng sync` rendered.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { hooks } from '../lib/render.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs');
const TEMPLATE = YAML.parse(fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8'));
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const Z = '0'.repeat(40);
const PROTECTED = ['main', 'dev', 'sandbox/john'];

// Test instrumentation: a script sources this to record its arguments and stdin, then reads the recorded stdin.
const REC_SH = `cat >"$REC/$NAME.stdin"
{ echo "$#"; printf '%s\\n' "$@"; } >"$REC/$NAME.args"
exec <"$REC/$NAME.stdin"
`;
// Kalsigns-shaped branch classes: main, sandbox/john and dev take no new ref and no fast-forward from a push.
const BRANCH_CLASSES = `#!/bin/sh
NAME=kal . scripts/rec.sh
z=${Z}
st=0
while read lref lsha rref rsha; do
  case "$rref" in refs/heads/main|refs/heads/sandbox/john|refs/heads/dev) ;; *) continue ;; esac
  [ "$lsha" = "$z" ] && continue
  if [ "$rsha" = "$z" ]; then echo "kalsigns: new ref $rref refused" >&2; st=1
  elif git merge-base --is-ancestor "$rsha" "$lsha"; then echo "kalsigns: fast-forward to $rref refused" >&2; st=1; fi
done
exit $st
`;
const SCRIPTS = {
  'scripts/rec.sh': REC_SH,
  'scripts/pass.sh': '#!/bin/sh\nNAME=pass . scripts/rec.sh\nexit 0\n',
  'scripts/fail.sh': '#!/bin/sh\nNAME=fail . scripts/rec.sh\nexit 7\n',
  'scripts/git-hooks/branch-classes.sh': BRANCH_CLASSES,
};
const COMMANDS = {
  none: null,
  kalsigns: { cmd: 'scripts/git-hooks/branch-classes.sh "$@"', rec: 'kal', exit: 1 },
  pass: { cmd: 'scripts/pass.sh "$@"', rec: 'pass' },
  fail: { cmd: 'scripts/fail.sh "$@"', rec: 'fail', exit: 7 },
};

// A work clone with commits c0 <- c1 <- c2 (branch work) and c1 <- x (branch side), every object already on the remote.
function scratch(mode, prePush) {
  const root = tmp('eng-pp-'), remote = path.join(root, 'remote.git'), w = path.join(root, 'w'), rec = path.join(root, 'rec');
  fs.mkdirSync(rec);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/unborn']);
  execFileSync('git', ['init', '-q', '-b', 'main', w]);
  const env = { ...process.env, REC: rec, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => spawnSync('git', a, { cwd: w, encoding: 'utf8', env });
  const rgit = (...a) => spawnSync('git', ['--git-dir', remote, ...a], { encoding: 'utf8' });
  const c = structuredClone(TEMPLATE);
  c.profile = 'slaytek';  // test/fixtures/pre-push-v0.16.2 is the Slaytek text; the hook's commands are the same in every profile
  c.git.rewrite_pushed = mode;
  c.project.protected_branches = PROTECTED;
  c.hooks = prePush === undefined ? {} : { pre_push: prePush };
  fs.writeFileSync(path.join(w, 'eng.config.yml'), YAML.stringify(c));
  for (const [f, body] of Object.entries(SCRIPTS)) { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), body, { mode: 0o755 }); }
  const s = spawnSync(process.execPath, [ENG, 'sync'], { cwd: w, encoding: 'utf8', env: { ...env, ENG_STANDARD_SOURCE: ROOT } });
  assert.equal(s.status, 0, s.stderr);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.hooksPath', '.githooks'], ['remote.origin.url', remote]]) git('config', k, v);
  const commit = m => { assert.equal(git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', m, '--allow-empty').status, 0); return git('rev-parse', 'HEAD').stdout.trim(); };
  git('add', '-A');
  const c0 = commit('c0'), c1 = commit('c1'), c2 = commit('c2');
  git('branch', '-q', 'work', c2); git('branch', '-q', 'older', c1);
  git('checkout', '-q', '-b', 'side', c1); const x = commit('x'); git('checkout', '-q', 'main');
  assert.equal(git('push', '-q', '--no-verify', 'origin', 'work:refs/keep/work', 'side:refs/keep/side').status, 0);
  // Sets the remote's branches and tags to exactly `refs` ({name: sha}); refs/keep/* hold the objects.
  const setRemote = refs => {
    const cur = rgit('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').stdout.split('\n').filter(Boolean);
    const lines = [...cur.filter(r => !(r in refs)).map(r => `delete ${r}`), ...Object.entries(refs).map(([r, sha]) => `update ${r} ${sha}`)];
    if (!lines.length) return;
    const r = spawnSync('git', ['--git-dir', remote, 'update-ref', '--stdin'], { input: lines.join('\n') + '\n', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const remoteRefs = () => Object.fromEntries(rgit('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags').stdout.split('\n').filter(Boolean).map(l => l.split(' ')));
  const recorded = () => Object.fromEntries(fs.readdirSync(rec).map(f => [f, fs.readFileSync(path.join(rec, f), 'utf8')]));
  const clearRec = () => fs.readdirSync(rec).forEach(f => fs.rmSync(path.join(rec, f)));
  return { w, remote, git, setRemote, remoteRefs, recorded, clearRec, sha: { c0, c1, c2, x } };
}

// Each ref kind for a target branch t: the remote's state before, the push refspecs, the ref lines git hands the hook,
// and the remote's state after an accepted push.
const tagOf = t => t.replace('/', '-');
const KINDS = {
  'new branch': ({ c2 }, t) => ({ before: {}, push: [`refs/heads/work:refs/heads/${t}`], lines: [`refs/heads/work ${c2} refs/heads/${t} ${Z}`], after: { [`refs/heads/${t}`]: c2 } }),
  'fast-forward': ({ c1, c2 }, t) => ({ before: { [`refs/heads/${t}`]: c1 }, push: [`refs/heads/work:refs/heads/${t}`], lines: [`refs/heads/work ${c2} refs/heads/${t} ${c1}`], after: { [`refs/heads/${t}`]: c2 } }),
  'non-fast-forward': ({ c2, x }, t) => ({ before: { [`refs/heads/${t}`]: x }, push: [`+refs/heads/work:refs/heads/${t}`], lines: [`refs/heads/work ${c2} refs/heads/${t} ${x}`], after: { [`refs/heads/${t}`]: c2 } }),
  delete: ({ c1 }, t) => ({ before: { [`refs/heads/${t}`]: c1 }, push: [`:refs/heads/${t}`], lines: [`(delete) ${Z} refs/heads/${t} ${c1}`], after: {} }),
  'tag move': ({ c1, c2 }, t) => ({ before: { [`refs/tags/v-${tagOf(t)}`]: c1 }, local: { [`v-${tagOf(t)}`]: c2 }, push: [`+refs/tags/v-${tagOf(t)}:refs/tags/v-${tagOf(t)}`], lines: [`refs/tags/v-${tagOf(t)} ${c2} refs/tags/v-${tagOf(t)} ${c1}`], after: { [`refs/tags/v-${tagOf(t)}`]: c2 } }),
  'several refs': ({ c1, c2 }, t) => ({
    before: { [`refs/heads/${t}`]: c1 }, local: { [`n-${tagOf(t)}`]: c2 },
    push: [`refs/heads/work:refs/heads/${t}`, `refs/tags/n-${tagOf(t)}:refs/tags/n-${tagOf(t)}`, 'refs/heads/side:refs/heads/extra'],
    lines: [`refs/heads/work ${c2} refs/heads/${t} ${c1}`, `refs/tags/n-${tagOf(t)} ${c2} refs/tags/n-${tagOf(t)} ${Z}`, `refs/heads/side PLACEHOLDER refs/heads/extra ${Z}`],
    after: { [`refs/heads/${t}`]: c2, [`refs/tags/n-${tagOf(t)}`]: c2, 'refs/heads/extra': 'PLACEHOLDER' },
  }),
};
const TARGETS = { main: 'main', 'a protected branch': 'dev', 'a feature branch': 'feat/x' };
const MODES = ['never', 'protected'];

// The oracle, from the requirement: eng's own refusals (git.rewrite_pushed), then the Kalsigns-shaped rules.
const isProt = t => PROTECTED.includes(t);
const engRefuses = (kind, t, mode) => kind === 'tag move' || (kind === 'delete' && isProt(t)) || (kind === 'non-fast-forward' && (mode === 'never' || isProt(t)));
const kalRefuses = (kind, t) => ['main', 'sandbox/john', 'dev'].includes(t) && ['new branch', 'fast-forward', 'several refs'].includes(kind);

test('full sweep: refs x targets x repo commands x rewrite modes, real pushes through the rendered hook', () => {
  let rows = 0;
  for (const mode of MODES) for (const [cmdName, spec] of Object.entries(COMMANDS)) {
    const r = scratch(mode, spec ? [spec.cmd] : undefined);
    const hook = fs.readFileSync(path.join(r.w, '.githooks/pre-push'), 'utf8');
    if (!spec) assert.equal(hook, fs.readFileSync(path.join(ROOT, 'test/fixtures/pre-push-v0.16.2', mode), 'utf8'), `${mode}: no key renders the v0.16.2 hook byte for byte`);
    const side = r.git('rev-parse', 'side').stdout.trim();
    for (const [kind, make] of Object.entries(KINDS)) for (const [tName, t] of Object.entries(TARGETS)) {
      const row = `${mode} | ${cmdName} | ${kind} | ${tName}`;
      const k = make(r.sha, t);
      const lines = k.lines.map(l => l.replace('PLACEHOLDER', side)), afterRefs = Object.fromEntries(Object.entries(k.after).map(([a, b]) => [a, b.replace('PLACEHOLDER', side)]));
      for (const [tag, sha] of Object.entries(k.local ?? {})) r.git('tag', '-f', tag, sha);
      const eng = engRefuses(kind, t, mode), byCmd = !eng && !!spec && (cmdName === 'fail' || (cmdName === 'kalsigns' && kalRefuses(kind, t)));
      const accepted = !eng && !byCmd;

      r.setRemote(k.before); r.clearRec();
      const p = r.git('push', 'origin', ...k.push);
      assert.equal(p.status === 0, accepted, `${row}: push ${accepted ? 'accepted' : 'refused'}\n${p.stderr}`);
      assert.deepEqual(r.remoteRefs(), accepted ? afterRefs : k.before, `${row}: remote refs`);
      const rec = r.recorded();
      if (eng) {
        assert.match(p.stderr, /eng: (non-fast-forward push to \S+ blocked|deleting protected branch \S+ is blocked|refs\/tags\/\S+ is already pushed)/, `${row}: eng's own refusal`);
        assert.deepEqual(rec, {}, `${row}: eng refused first, so no repo command ran`);
      } else if (!spec) {
        assert.deepEqual(rec, {}, row);
      } else {
        assert.deepEqual(rec, { [`${spec.rec}.args`]: `2\norigin\n${r.remote}\n`, [`${spec.rec}.stdin`]: lines.map(l => `${l}\n`).join('') }, `${row}: the command saw the hook's arguments and its exact stdin`);
        if (byCmd) assert.ok(p.stderr.includes(`eng: hooks.pre_push command 1 of 1 failed (exit ${spec.exit}): ${spec.cmd}`), `${row}: names the failing command\n${p.stderr}`);
      }

      r.setRemote(k.before); r.clearRec();
      const nv = r.git('push', '--no-verify', 'origin', ...k.push);
      assert.equal(nv.status, 0, `${row}: --no-verify skips the hook\n${nv.stderr}`);
      assert.deepEqual(r.recorded(), {}, `${row}: --no-verify runs no repo command`);
      rows++;
    }
  }
  assert.equal(rows, MODES.length * Object.keys(COMMANDS).length * Object.keys(KINDS).length * Object.keys(TARGETS).length);
  assert.equal(rows, 144);
});

test('Kalsigns-shaped repo: its branch classes in hooks.pre_push refuse all 12 protected pushes and allow ordinary ones', () => {
  for (const mode of MODES) {
    const r = scratch(mode, [COMMANDS.kalsigns.cmd]);
    const { c0, c1, c2 } = r.sha, parent = { [c2]: c1, [c1]: c0 };
    const cases = [];
    for (const b of ['main', 'sandbox/john', 'dev', 'task/probe']) for (const [local, sha] of [['work', c2], ['older', c1]]) for (const shape of ['new', 'fast-forward'])
      cases.push({ b, local, sha, shape, before: shape === 'new' ? {} : { [`refs/heads/${b}`]: parent[sha] } });
    let refused = 0, allowed = 0;
    for (const k of cases) {
      const what = `${mode}: ${k.shape} ${k.local} -> ${k.b}`, forbidden = k.b !== 'task/probe';
      r.setRemote(k.before);
      const p = r.git('push', 'origin', `refs/heads/${k.local}:refs/heads/${k.b}`);
      assert.equal(p.status !== 0, forbidden, `${what}\n${p.stderr}`);
      if (forbidden) { assert.match(p.stderr, new RegExp(`kalsigns: (new ref|fast-forward to) refs/heads/${k.b} refused`), what); refused++; }
      else { assert.deepEqual(r.remoteRefs(), { [`refs/heads/${k.b}`]: k.sha }, what); allowed++; }
    }
    assert.deepEqual({ refused, allowed }, { refused: 12, allowed: 4 }, mode);
  }
});

// The hook body alone, run by sh with crafted stdin bytes: each command gets the same bytes, in order.
const runHook = (prePush, input, args = ['origin', 'https://example.invalid/r.git']) => {
  const d = tmp('eng-pp-run-'), rec = path.join(d, 'rec'), file = path.join(d, 'pre-push');
  fs.mkdirSync(rec);
  fs.writeFileSync(file, hooks({ project: { default_branch: 'main' }, agents: { harnesses: [] }, hooks: { pre_push: prePush } })['.githooks/pre-push']);
  const r = spawnSync('/bin/sh', [file, ...args], { input, cwd: d, encoding: 'utf8', env: { ...process.env, REC: rec, TMPDIR: d } });
  const files = fs.readdirSync(d).filter(f => !['rec', 'pre-push'].includes(f));
  return { ...r, file, rec: Object.fromEntries(fs.readdirSync(rec).map(f => [f, fs.readFileSync(path.join(rec, f), 'utf8')])), leftovers: files };
};
const save = n => `cat >"$REC/${n}"; printf '%s|' "$0" "$@" >"$REC/${n}.args"`;

test('every command gets the identical stdin, an empty one included, and the hook removes its temp file', () => {
  for (const input of ['', `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${Z}\n`, 'no trailing newline\twith tab \\ and é', 'x\r\ny\n\n']) {
    const r = runHook([save('one'), save('two'), save('three')], input);
    assert.equal(r.status, 0, r.stderr);
    for (const n of ['one', 'two', 'three']) assert.equal(r.rec[n], input, `${n} got the same bytes for ${JSON.stringify(input)}`);
    assert.equal(r.rec['one.args'], `${r.file}|origin|https://example.invalid/r.git|`, 'the hook path and its arguments');
    assert.deepEqual(r.leftovers, [], 'no temp file left behind');
  }
});

test('commands run in order and the push stops at the first failure, which is named with its exit code', () => {
  const r = runHook(['echo 1 >>"$REC/order"', "echo 2 >>\"$REC/order\"; exit 5 # it's", 'echo 3 >>"$REC/order"'], '');
  assert.equal(r.status, 5);
  assert.equal(r.rec.order, '1\n2\n');
  assert.ok(r.stderr.includes(`eng: hooks.pre_push command 2 of 3 failed (exit 5): echo 2 >>"$REC/order"; exit 5 # it's`), r.stderr);
  assert.deepEqual(r.leftovers, []);
});

test('an eng refusal on any ref line stops the hook before the first command', () => {
  const r = runHook(['echo ran >"$REC/ran"'], `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${Z}\nrefs/tags/v1 ${'1'.repeat(40)} refs/tags/v1 ${'2'.repeat(40)}\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /eng: refs\/tags\/v1 is already pushed/);
  assert.deepEqual(r.rec, {});
  assert.deepEqual(r.leftovers, []);
});

test('no hooks.pre_push, or an empty list, renders the v0.16.2 hook byte for byte', () => {
  for (const mode of MODES) {
    const want = fs.readFileSync(path.join(ROOT, 'test/fixtures/pre-push-v0.16.2', mode), 'utf8');
    const base = { profile: 'slaytek', project: { default_branch: 'main', protected_branches: PROTECTED }, agents: { harnesses: ['claude-code'] }, git: { rewrite_pushed: mode } };
    assert.equal(hooks(base)['.githooks/pre-push'], want, `${mode}: absent key`);
    assert.equal(hooks({ ...base, hooks: { pre_push: [] } })['.githooks/pre-push'], want, `${mode}: empty list`);
    assert.equal(hooks({ ...base, hooks: { pre_commit: ['true'] } })['.githooks/pre-push'], want, `${mode}: pre_commit alone`);
    const generic = hooks({ ...base, profile: 'generic' })['.githooks/pre-push'];
    assert.equal(generic, want.replace(/ \(Matt, \d+ Nov 2026\)/, ''), `${mode}: generic drops only the attribution`);
  }
});

test('hooks.pre_push must be a list of non-empty commands', () => {
  for (const bad of ['scripts/x.sh', [''], ['ok', '  '], [1], {}]) {
    const d = tmp('eng-pp-bad-');
    execFileSync('git', ['init', '-q', d]);
    const c = structuredClone(TEMPLATE); c.hooks = { pre_push: bad };
    fs.writeFileSync(path.join(d, 'eng.config.yml'), YAML.stringify(c));
    const s = spawnSync(process.execPath, [ENG, 'sync', '--check'], { cwd: d, encoding: 'utf8' });
    assert.notEqual(s.status, 0, JSON.stringify(bad));
    assert.match(s.stderr, /hooks\.pre_push must be a list of non-empty commands/, JSON.stringify(bad));
  }
});

test('eng doctor fails a hook command whose repo-relative script is missing or not executable', () => {
  const r = scratch('never', ['scripts/pass.sh "$@"', './scripts/missing.sh', 'scripts/plain.sh', 'npm test', '/bin/true', '"$HOME/x.sh"']);
  fs.writeFileSync(path.join(r.w, 'scripts/plain.sh'), '#!/bin/sh\n', { mode: 0o644 });
  const c = YAML.parse(fs.readFileSync(path.join(r.w, 'eng.config.yml'), 'utf8')); c.hooks.pre_commit = ['scripts/gone.sh --fast'];
  fs.writeFileSync(path.join(r.w, 'eng.config.yml'), YAML.stringify(c));
  const d = spawnSync(process.execPath, [ENG, 'doctor'], { cwd: r.w, encoding: 'utf8', env: { ...process.env, ENG_STANDARD_SOURCE: ROOT } });
  const out = d.stdout + d.stderr;
  assert.match(out, /ok {3}hooks\.pre_push\[0\]: scripts\/pass\.sh is an executable file/);
  assert.match(out, /FAIL hooks\.pre_push\[1\]: \.\/scripts\/missing\.sh is missing/);
  assert.match(out, /FAIL hooks\.pre_push\[2\]: scripts\/plain\.sh is not executable .*chmod \+x scripts\/plain\.sh/);
  assert.match(out, /FAIL hooks\.pre_commit\[0\]: scripts\/gone\.sh is missing/);
  assert.doesNotMatch(out, /hooks\.pre_push\[[345]\]/, 'PATH commands, absolute paths and variables are not checked');
  assert.notEqual(d.status, 0);
});

// PR #56 verdict 1: the hook created its temp file before its cleanup trap, so a signal in between left the file behind.
// The hook now keeps the ref lines in memory and never creates a file: a stand-in mktemp that pauses after creating one
// proves it is never called, and a signal mid-run leaves nothing behind.
test('the hook makes no temp file, so a signal at any point leaves nothing behind and the push fails', async () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const d = tmp('eng-pp-sig-'), bin = path.join(d, 'bin'), rec = path.join(d, 'rec'), file = path.join(d, 'pre-push');
    fs.mkdirSync(bin); fs.mkdirSync(rec);
    fs.writeFileSync(path.join(bin, 'mktemp'), `#!/bin/sh\necho called >"${rec}/mktemp-called"\nf=$(/usr/bin/mktemp "$@") || exit 1\necho "$f"\nsleep 2\n`, { mode: 0o755 });
    fs.writeFileSync(file, hooks({ project: { default_branch: 'main' }, agents: { harnesses: [] }, hooks: { pre_push: ['sleep 2'] } })['.githooks/pre-push']);
    const before = fs.readdirSync(d).sort();
    const p = spawn('/bin/sh', [file, 'origin', 'u'], { cwd: d, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: d }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(`refs/heads/a ${'1'.repeat(40)} refs/heads/a ${Z}\n`);
    await new Promise(r => setTimeout(r, 500));
    p.kill(sig);
    const code = await new Promise(r => p.on('close', (c, s) => r(c ?? s)));
    assert.notEqual(code, 0, `${sig}: the push does not go through`);
    assert.ok(!fs.existsSync(path.join(rec, 'mktemp-called')), `${sig}: the hook never calls mktemp`);
    assert.deepEqual(fs.readdirSync(d).sort(), before, `${sig}: nothing left in TMPDIR`);
  }
});

// PR #56 verdict 1 note: a script gets the hook's arguments only when its command passes them on. Doctor says so.
test('eng doctor warns when a hooks.pre_push script is called without the hook arguments', () => {
  const r = scratch('never', ['scripts/pass.sh "$@"', 'scripts/pass.sh', 'scripts/pass.sh "$1" "$2"', 'npm test']);
  const d = spawnSync(process.execPath, [ENG, 'doctor'], { cwd: r.w, encoding: 'utf8', env: { ...process.env, ENG_STANDARD_SOURCE: ROOT } });
  const out = d.stdout + d.stderr;
  assert.match(out, /WARN hooks\.pre_push\[1\]: scripts\/pass\.sh gets none of the hook's arguments \(remote name, URL\); pass them on: scripts\/pass\.sh "\$@"/);
  assert.doesNotMatch(out, /WARN hooks\.pre_push\[[023]\]/, 'commands that pass the arguments, or are not repo scripts, get no warning');
});

// PR #56 verdict 2 (P1): `in=$(cat; echo .)` took echo's status, so a failed, partial or interrupted read of the ref
// lines left eng's checks with nothing to refuse, and a protected delete went through. A failed capture now fails the push.
test('a failed, partial or interrupted read of the ref lines fails the push before any check or command', () => {
  const deleteMain = `refs/heads/main ${Z} refs/heads/main ${'1'.repeat(40)}\n`;
  const cats = {
    'exits 23 with no output': 'exit 23',
    'prints one ref line, then exits 23': `printf '%s' '${deleteMain}'; exit 23`,
    'is killed by SIGTERM after one line': `printf '%s' '${deleteMain}'; kill -TERM $$`,
  };
  for (const [name, body] of Object.entries(cats)) {
    const d = tmp('eng-pp-cat-'), bin = path.join(d, 'bin'), rec = path.join(d, 'rec'), file = path.join(d, 'pre-push');
    fs.mkdirSync(bin); fs.mkdirSync(rec);
    fs.writeFileSync(path.join(bin, 'cat'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.writeFileSync(file, hooks({ project: { default_branch: 'main' }, agents: { harnesses: [] }, hooks: { pre_push: [`touch "${rec}/ran"`] } })['.githooks/pre-push']);
    const r = spawnSync('/bin/sh', [file, 'origin', 'u'], { input: deleteMain, cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(r.status, 0, `cat ${name}: the push must fail`);
    assert.ok(!fs.existsSync(path.join(rec, 'ran')), `cat ${name}: no repo command runs`);
  }
});
