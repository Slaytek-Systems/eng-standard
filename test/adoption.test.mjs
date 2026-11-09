// The Kalsigns adoption of v0.16 (8 Nov 2026) hit five gaps; each test here is the next adopter's repo meeting one of them.
// Evidence: Core nd7cpb3k1atph5xsgdfzt4nm4d8ht44g and the Kalsigns dispatch README, "eng-standard gaps".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { enforcer } from '../lib/budget.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const TPL = path.join(PKG, 'templates/eng.config.yml');
const out = r => r.stdout + r.stderr;
const systemd = (() => { try { return enforcer({}) === 'systemd'; } catch { return false; } })();
const scratch = [];
after(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

// A fresh repo on the template config: no required gates, ephemeral runs unwatched, one run per check.
function repo(edit = c => c) {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-adopt-')); scratch.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  c.gates.required = []; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.verification.flake_runs = 1;
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(edit(c)));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base');
  const eng = (args, env = {}) => { const e = { ...process.env, ...env }; if (!('CI' in env)) delete e.CI; return spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: e }); };
  const checks = files => {
    fs.mkdirSync(path.join(dir, '.eng/checks'), { recursive: true });
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.eng/checks', `${n}.sh`), body, { mode: 0o755 });
    git('add -A'); git('commit -qm checks --allow-empty');
  };
  return { dir, git, eng, checks };
}
// ---------- 1. PR template: GitHub reads .github/, the root or docs/, any case, and a PULL_REQUEST_TEMPLATE/ folder ----------
const ENG_TEMPLATE = '.github/pull_request_template.md';
for (const own of ['.github/PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE/feature.md'])
  test(`a repo with its own PR template (${own}) keeps it: eng sync renders none, touches none, and eng doctor names it`, () => {
    const { dir, eng } = repo();
    fs.mkdirSync(path.dirname(path.join(dir, own)), { recursive: true });
    fs.writeFileSync(path.join(dir, own), '## Our template\n');
    let r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    assert.equal(fs.readFileSync(path.join(dir, own), 'utf8'), '## Our template\n', 'the repo\'s own template is untouched');
    assert.ok(!(fs.existsSync(path.join(dir, '.github')) && fs.readdirSync(path.join(dir, '.github')).includes('pull_request_template.md')), `eng rendered no ${ENG_TEMPLATE} beside ${own}: ${out(r)}`);
    r = eng(['sync', '--check']);
    assert.equal(r.status, 0, out(r));
    r = eng(['doctor'], { ENG_STANDARD_SOURCE: PKG });
    const named = own.endsWith('/feature.md') ? path.dirname(own) : own;
    assert.match(r.stdout, new RegExp(`PR template: ${named.replace(/[./]/g, '\\$&')} \\(the repo's own; eng renders none\\)`), out(r));
  });

test('eng keeps rendering its PR template when it is the only one, and a second sync changes nothing', () => {
  const { dir, eng, git } = repo();
  let r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.match(fs.readFileSync(path.join(dir, ENG_TEMPLATE), 'utf8'), /\S/, 'eng\'s template is written');
  git('add -A'); git('commit -qm sync');
  r = eng(['sync']); assert.match(r.stdout, /eng sync: no changes/, out(r));
  r = eng(['doctor'], { ENG_STANDARD_SOURCE: PKG });
  assert.match(r.stdout, /PR template: \.github\/pull_request_template\.md \(eng's\)/, out(r));
});

// ---------- 2. per-step TMPDIR short enough for a unix socket (tsx IPC: $TMPDIR/tsx-<uid>/<pid>.pipe) ----------
// The repo name is long on purpose: before, it appeared twice in every step's TMPDIR.
const SOCK_CHECK = `#!/usr/bin/env bash
mkdir -p "$TMPDIR/tsx-1000"
for p in "$TMPDIR/tsx-1000/12345.pipe" "$TMPDIR/${'s'.repeat(40)}"; do
  echo "socket path $p (\${#p} bytes)"
  node -e 'const s=require("net").createServer().listen(process.argv[1],()=>{console.log("bound "+process.argv[1]);s.close()}).on("error",e=>{console.log("Error: "+e.code+" "+process.argv[1]);process.exit(1)})' "$p" || exit 1
done
rm -rf "$TMPDIR/tsx-1000"
`;
for (const how of ['systemd', 'watchdog']) for (const via of ['eng gate', 'eng run -- eng gate'])
  test(`a check binds unix sockets in its TMPDIR through ${via} (${how})`, t => {
    if (how === 'systemd' && !systemd) return t.skip('systemd-run --user --scope does not work on this machine');
    const { eng, checks } = repo(c => { c.project.name = 'kalsigns-quote-versions-workspace'; return c; });
    checks({ sock: SOCK_CHECK });
    const gate = ['gate', 'checks'], r = eng(via === 'eng gate' ? gate : ['run', '--', process.execPath, ENG, ...gate], { ENG_BUDGET_ENFORCER: how });
    t.diagnostic(out(r));
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /pass\s+check:sock/);
  });

// ---------- 3. a failing step's reason names a failing line, and the end of its output is printed; eng keeps no file ----------
const TAP = `TAP version 13
ok 1 - reports failed uploads
ok 2 - retries failed jobs
not ok 3 - totals the quote
  ---
  error: 'Expected 10, got 9'
  ...
# pass 2
# fail 1
`;
const NODE_TEST = `✔ reports failed uploads (1.2ms)
✔ marks failed payments as retryable (0.8ms)
✖ totals the quote (2.1ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1
`;
const COLOR = '\x1b[32m✓ reports Error: upload failure\x1b[0m\n\x1b[31m× totals the quote\x1b[0m\n';
const TAIL_HEAD = /^eng gate: (\S+) failed; the end of its output \(at most 40 lines, 8 KiB\):$/;
// The gate's stderr, split into each failed step's printed tail.
const tails = r => {
  const outv = {}; let cur = null;
  for (const l of r.stderr.split('\n')) { const m = l.match(TAIL_HEAD); if (m) outv[cur = m[1]] = []; else if (cur && l.startsWith('eng: FAIL gate:')) cur = null; else if (cur) outv[cur].push(l); }
  return Object.fromEntries(Object.entries(outv).map(([k, v]) => [k, v.join('\n')]));
};
const files = d => { try { return fs.readdirSync(d, { recursive: true }); } catch { return []; } };
for (const [kind, output, why] of [['TAP', TAP, /not ok 3 - totals the quote/], ['node --test', NODE_TEST, /✖ totals the quote/], ['coloured vitest', COLOR, /× totals the quote/]])
  test(`a failing check's reason is a failing line, never a passing test (${kind}), and the gate prints the end of its output`, () => {
    const { eng, checks } = repo();
    checks({ suite: `#!/usr/bin/env bash\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit 1\n` });
    const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
    assert.equal(r.status, 1, out(r));
    const row = r.stdout.split('\n').find(l => /FAIL\s+check:suite/.test(l));
    assert.ok(row, out(r));
    assert.match(row, why, `the reason is the failing test: ${row}`);
    assert.doesNotMatch(row, /reports failed uploads|retries failed jobs|marks failed payments|upload failure/);
    assert.equal(tails(r)['check:suite'], output.trimEnd(), out(r));
    assert.doesNotMatch(out(r), /full output:/);
  });

test('a failing step writes no file: none in the cache, and none in the repo when XDG_CACHE_HOME is inside it', () => {
  const { dir, eng, checks, git } = repo();
  checks({ suite: '#!/usr/bin/env bash\necho not ok 1 - broke\nexit 1\n' });
  const before = files(process.env.XDG_CACHE_HOME);
  let r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.deepEqual(files(process.env.XDG_CACHE_HOME).filter(f => /failed/.test(f)), before.filter(f => /failed/.test(f)), 'no failure log under XDG_CACHE_HOME');
  r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog', XDG_CACHE_HOME: path.join(dir, '.cache') });
  assert.equal(r.status, 1, out(r));
  assert.equal(git('ls-files --others --exclude-standard'), '', 'the failing gate left nothing in the repo');
});

test('a check that exits 0 but fails for what it left in its TMPDIR prints the end of its output', () => {
  const { eng, checks } = repo();
  checks({ leaky: '#!/usr/bin/env bash\necho DIAGNOSTIC\ntouch "$TMPDIR/leak"\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /FAIL\s+check:leaky\s+left 1 entry in its private TMPDIR: leak/);
  assert.match(tails(r)['check:leaky'] ?? '', /^DIAGNOSTIC$/m, out(r));
});

test('two failing checks whose names slug alike each print their own output', () => {
  const { eng, checks } = repo();
  checks({ 'a+b': '#!/usr/bin/env bash\necho OUT-PLUS\nexit 1\n', 'a-b': '#!/usr/bin/env bash\necho OUT-MINUS\nexit 1\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' }), t = tails(r);
  assert.equal(r.status, 1, out(r));
  assert.match(t['check:a+b'] ?? '', /OUT-PLUS/, out(r)); assert.doesNotMatch(t['check:a+b'], /OUT-MINUS/);
  assert.match(t['check:a-b'] ?? '', /OUT-MINUS/, out(r)); assert.doesNotMatch(t['check:a-b'], /OUT-PLUS/);
});

const NOISY = `printf 'FIRST\\n'; head -c 2097152 /dev/zero | tr '\\0' x; printf '\\nLAST\\n'; exit 1`;
test('a very noisy failing gate command fails as itself (exit 1, not killed) and prints the end of its output, bounded', () => {
  const { eng } = repo(c => { c.gates.required = ['test']; c.project.commands.test = NOISY; return c; });
  const r = eng(['gate', 'test'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.doesNotMatch(r.stderr, /interrupted/);
  const t = tails(r).test ?? '';
  assert.match(t, /LAST$/, out(r).slice(-2000)); assert.doesNotMatch(t, /FIRST/);
  assert.ok(Buffer.byteLength(t) <= 8192, `at most 8 KiB: ${Buffer.byteLength(t)}`);
});

test('a very noisy failing check prints at most 40 lines and 8 KiB of its end', () => {
  const { eng, checks } = repo();
  checks({ noisy: '#!/usr/bin/env bash\necho FIRST-LINE\nseq 1 100000\nhead -c 3000000 /dev/zero | tr "\\0" "x"\necho\necho LAST-LINE\nexit 1\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  const t = tails(r)['check:noisy'] ?? '';
  assert.match(t, /LAST-LINE$/, out(r).slice(-2000)); assert.doesNotMatch(t, /FIRST-LINE/);
  assert.ok(Buffer.byteLength(t) <= 8192 && t.split('\n').length <= 40, `bounded: ${Buffer.byteLength(t)} bytes, ${t.split('\n').length} lines`);
});

// ---------- 4. eng manages real folders only: a symlinked .claude, skills or agents folder is left alone and reported ----------
// Core decision nd70ke343v7gc0eakdejg7m5f18hx1p9: eng manages repo-local things only and does not care how a developer
// arranges their skills folders. 0.17.1 refused a symlinked .claude/skills; PR #58 rounds 1 and 2 found a bug in each way
// of following such a link to write there. eng now writes, links and prunes only where every folder down is real.
const SOURCE = { skills: '.agents/skills', agents: '.agents/agents' };
// The developer's own entries in a shared folder; grilling and poteto-agent.md share a name with eng's.
const FOREIGN = { skills: ['mine', 'grilling', 'domain-modeling'], agents: ['mine.md', 'poteto-agent.md'] };
function plantForeign(root, kind) {
  if (kind === 'skills') {
    for (const n of ['mine', 'grilling']) { fs.mkdirSync(path.join(root, n), { recursive: true }); fs.writeFileSync(path.join(root, n, 'SKILL.md'), `my ${n}\n`); }
    fs.symlinkSync('/nonexistent/elsewhere/domain-modeling', path.join(root, 'domain-modeling'));
  } else {
    fs.mkdirSync(root, { recursive: true });
    for (const n of FOREIGN.agents) fs.writeFileSync(path.join(root, n), `my ${n}\n`);
  }
}
const pick = (snap, prefixes) => Object.fromEntries(Object.entries(snap).filter(([k]) => prefixes.some(p => k === p || k.startsWith(`${p}/`))));
const elsewhere = () => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-elsewhere-')); scratch.push(d); return d; };
// A config doctor passes on, so a doctor exit 1 can only be the link.
const doctorClean = c => { c.agents.rules = []; c.constraints.rules = []; c.hygiene.run_rules.ephemeral_runs.mode = 'fail'; return c; };
const doctor = eng => eng(['doctor'], { ENG_STANDARD_SOURCE: PKG });
// Every entry under dir, never following a link: type, mode, and bytes or link target. A folder that cannot be read says so.
function deep(dir) {
  const snap = {};
  const walk = rel => {
    const abs = path.join(dir, rel), st = fs.lstatSync(abs), mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) { snap[rel] = `link ${fs.readlinkSync(abs)}`; return; }
    if (st.isFile()) { let b; try { b = fs.readFileSync(abs, 'utf8'); } catch { b = '(unreadable)'; } snap[rel] = `file ${mode} ${b}`; return; }
    let names; try { names = fs.readdirSync(abs); } catch { snap[rel] = `dir ${mode} (unreadable)`; return; }
    snap[rel] = `dir ${mode}`;
    for (const n of names) if (n !== '.git') walk(path.join(rel, n));
  };
  walk('.');
  return snap;
}

const FOLDERS = ['.claude', '.claude/skills', '.claude/agents', '.agents/skills'];
const groupsOf = f => f === '.claude' ? ['skills', 'agents'] : [f.split('/')[1]];
const up = f => '../'.repeat(f.split('/').length - 1);
// Each kind makes the link at f in dir, with whatever it reaches under ext, and says whether the developer's entries are there.
const KINDS = {
  'inside the repo': (f, dir) => ({ text: `${up(f)}mine/${path.basename(f)}`, reached: path.join(dir, 'mine', path.basename(f)) }),
  'outside the repo': (f, dir, ext) => ({ text: path.join(ext, 'shared'), reached: path.join(ext, 'shared') }),
  'chained with ..': (f, dir, ext) => { fs.mkdirSync(path.join(ext, 'deep')); fs.symlinkSync(path.join(ext, 'deep'), path.join(dir, 'jump')); return { text: `${up(f)}jump/../shared`, reached: path.join(ext, 'shared') }; },
  looping: f => ({ text: path.basename(f) }),
  dangling: f => ({ text: `${up(f)}missing` }),
  unreadable: (f, dir, ext) => ({ text: path.join(ext, 'private'), reached: path.join(ext, 'private'), locked: true }),
};
const re = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));

for (const f of FOLDERS) for (const [kind, make] of Object.entries(KINDS))
  test(`${f} as a symlink ${kind}: sync, --check and doctor pass, nothing it reaches or outside changes, and the report says what the harnesses find`, () => {
    const { dir, eng } = repo(doctorClean);
    const ext = elsewhere(), l = make(f, dir, ext);
    if (l.reached) {
      if (f === '.claude') { plantForeign(path.join(l.reached, 'skills'), 'skills'); plantForeign(path.join(l.reached, 'agents'), 'agents'); fs.writeFileSync(path.join(l.reached, 'settings.json'), '{"mine":true}\n'); }
      else plantForeign(l.reached, groupsOf(f)[0]);
    }
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.symlinkSync(l.text, path.join(dir, f));
    if (l.locked) fs.chmodSync(l.reached, 0o000);
    try {
      const snap = () => ({ ext: deep(ext), ...(kind === 'inside the repo' ? { mine: deep(path.join(dir, 'mine')) } : {}) });
      const before = snap();
      const r = eng(['sync']), c = eng(['sync', '--check']), d = doctor(eng), again = eng(['sync']);
      for (const x of [r, c, d, again]) assert.equal(x.status, 0, out(x));
      assert.deepEqual(snap(), before, 'every folder the link reaches, and everything outside the repo: same entries, modes, bytes and links');
      assert.equal(fs.readlinkSync(path.join(dir, f)), l.text, 'the link itself is untouched');
      assert.ok(!fs.existsSync(path.join(dir, 'missing')), 'nothing made where a dangling link points');
      assert.match(again.stdout, /eng sync: no changes/);
      assert.match(r.stdout, re(`left ${f} is a symlink to ${l.text}, so eng writes and deletes nothing through it.`));
      assert.match(c.stdout, re(`left ${f} is a symlink to ${l.text}`));
      assert.match(d.stdout, re(`WARN ${f} is a symlink to ${l.text}`));
      const found = l.reached && !l.locked;
      for (const g of groupsOf(f)) {
        const via = f === '.claude' ? `.claude/${g}` : f, what = g === 'skills' ? 'skills' : 'subagents';
        assert.match(r.stdout, re(found ? `Through ${via} the harnesses find 1 of eng's` : `Through ${via} the harnesses find none of eng's`), out(r));
        if (found) assert.match(r.stdout, new RegExp(`find 1 of eng's \\d+ ${what}; not [^(]*\\(`), 'names what it does not find');
      }
      if (f === '.claude') assert.match(r.stdout, /eng did not write \.claude\/settings\.json\./);
    } finally { if (l.locked) fs.chmodSync(l.reached, 0o755); }
  });

test('plain .claude folders link as in 0.17.1: one link per skill and subagent at ../../<source>/<name>, all in the lock, no notice', () => {
  const { dir, eng } = repo();
  const r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(r.stdout, /\bleft /);
  const links = [];
  for (const g of ['skills', 'agents']) for (const n of fs.readdirSync(path.join(dir, SOURCE[g]))) {
    assert.equal(fs.readlinkSync(path.join(dir, '.claude', g, n)), `../../${SOURCE[g]}/${n}`); links.push(`.claude/${g}/${n}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude/skills')).length + fs.readdirSync(path.join(dir, '.claude/agents')).length, links.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.eng/lock.json'), 'utf8')).links, links.sort());
});

test('a real folder or file where eng wants a link is never deleted: eng leaves it, says so, and links the rest', () => {
  const { dir, eng } = repo();
  fs.mkdirSync(path.join(dir, '.claude/skills/grilling'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude/skills/grilling/SKILL.md'), 'my grilling\n');
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude/agents/poteto-agent.md'), 'my agent\n');
  const mine = pick(deep(dir), ['.claude/skills/grilling', '.claude/agents/poteto-agent.md']);
  const r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(pick(deep(dir), ['.claude/skills/grilling', '.claude/agents/poteto-agent.md']), mine, 'both untouched');
  assert.match(r.stdout, /left \.claude\/skills\/grilling is a folder that eng did not make, so eng leaves it/);
  assert.match(r.stdout, /left \.claude\/agents\/poteto-agent\.md is a file that eng did not make/);
  assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills/retro')), '../../.agents/skills/retro');
  assert.equal(eng(['sync', '--check']).status, 0);
});

// PR #58 verdicts 1 and 2: each test below is one of their reproductions.
// A --require hook that changes the disk at one fs call, the way a developer or another process could while sync runs.
const hook = body => { const f = path.join(elsewhere(), 'hook.cjs'); fs.writeFileSync(f, `const fs = require('fs'), path = require('path'), at = p => path.join(process.cwd(), p);\n${body}\n`); return { NODE_OPTIONS: `--require=${f}` }; };
const FEWER = ['eng/eng-retro', 'pstack/statechart', 'pstack/create-formal-verification-skill'];
const setSkills = (dir, skills) => { const c = YAML.parse(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8')); c.agents.skills = skills; fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c)); };

for (const l of ['.claude/skills/grilling', '.claude/agents/poteto-agent.md']) for (const remove of [false, true])
  test(`a developer's link at ${l} where eng's was: the lock does not make it eng's, so sync ${remove ? 'with it dropped from the config prunes' : 'replaces'} nothing`, () => {
    const { dir, eng } = repo();
    assert.equal(eng(['sync']).status, 0);
    const mine = elsewhere(), at = path.join(dir, l);
    fs.unlinkSync(at); fs.symlinkSync(mine, at);
    if (remove) setSkills(dir, FEWER);
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    assert.equal(fs.readlinkSync(at), mine, `${l} still points at the developer's folder`);
    if (!remove) assert.match(r.stdout, re(`left ${l} is a link to ${mine} that eng did not make`));
    assert.equal(eng(['sync', '--check']).status, 0);
  });

test("an empty folder the developer made in eng's skills source is kept: cleanup removes only folders eng rendered", () => {
  const { dir, eng } = repo();
  fs.mkdirSync(path.join(dir, '.agents/skills/mine'), { recursive: true });
  assert.equal(eng(['sync']).status, 0);
  assert.ok(fs.lstatSync(path.join(dir, '.agents/skills/mine')).isDirectory(), '.agents/skills/mine is still there');
  setSkills(dir, FEWER);
  assert.equal(eng(['sync']).status, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.agents/skills/grilling')), 'a skill folder eng rendered and pruned is removed');
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/mine')));
});

for (const [f, drop] of [['.agents/skills', 'grilling'], ['.claude', 'the claude-code harness']])
  test(`${f} -> jump/../shared, where jump links outside: dropping ${drop} deletes nothing outside`, () => {
    const { dir, eng } = repo();
    const ext = elsewhere();
    fs.mkdirSync(path.join(ext, 'deep')); fs.mkdirSync(path.join(ext, 'shared')); fs.symlinkSync(path.join(ext, 'deep'), path.join(dir, 'jump'));
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.symlinkSync(`${up(f)}jump/../shared`, path.join(dir, f));
    assert.equal(eng(['sync']).status, 0);
    if (f === '.agents/skills') { fs.mkdirSync(path.join(ext, 'shared/grilling'), { recursive: true }); fs.writeFileSync(path.join(ext, 'shared/grilling/SKILL.md'), 'mine\n'); setSkills(dir, FEWER); }
    else { fs.writeFileSync(path.join(ext, 'shared/settings.json'), '{"mine":true}\n'); const c = YAML.parse(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8')); c.agents.harnesses = c.agents.harnesses.filter(h => h !== 'claude-code'); fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c)); }
    const before = deep(ext);
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    assert.deepEqual(deep(ext), before);
  });

for (const g of ['skills', 'agents'])
  test(`.claude/${g} -> ../.agents/${g}, which links outside the repo: sync, --check and doctor pass and say the harnesses find none of eng's`, () => {
    const { dir, eng } = repo(doctorClean);
    const ext = elsewhere();
    fs.mkdirSync(path.join(dir, '.agents')); fs.mkdirSync(path.join(dir, '.claude'));
    fs.symlinkSync(ext, path.join(dir, `.agents/${g}`)); fs.symlinkSync(`../.agents/${g}`, path.join(dir, `.claude/${g}`));
    const before = deep(ext);
    const r = eng(['sync']), c = eng(['sync', '--check']), d = doctor(eng);
    for (const x of [r, c, d]) assert.equal(x.status, 0, out(x));
    assert.deepEqual(deep(ext), before);
    assert.match(d.stdout, re(`WARN .claude/${g} is a symlink to ../.agents/${g}, so eng writes and deletes nothing through it. Through .claude/${g} the harnesses find none of eng's`));
  });

test("eng's skills source linked outside, holding a developer script that is not executable: --check does not enforce its mode", () => {
  const { dir, eng } = repo();
  const ext = elsewhere(), script = path.join(ext, 'statechart/scripts/statechart');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o640 });
  fs.mkdirSync(path.join(dir, '.agents')); fs.symlinkSync(ext, path.join(dir, '.agents/skills'));
  assert.equal(eng(['sync']).status, 0);
  const c = eng(['sync', '--check']);
  assert.equal(c.status, 0, out(c));
  assert.equal(fs.statSync(script).mode & 0o777, 0o640);
});

test(".claude/skills linked to one skill's folder in eng's source: sync leaves it, with no crash and no link inside the skill", () => {
  const { dir, eng } = repo();
  assert.equal(eng(['sync']).status, 0);
  fs.rmSync(path.join(dir, '.claude/skills'), { recursive: true }); fs.symlinkSync('../.agents/skills/grilling', path.join(dir, '.claude/skills'));
  const r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /left \.claude\/skills is a symlink to \.\.\/\.agents\/skills\/grilling/);
  assert.ok(!fs.readdirSync(path.join(dir, '.agents/skills/grilling')).some(n => fs.lstatSync(path.join(dir, '.agents/skills/grilling', n)).isSymbolicLink()), 'no link written into grilling');
  assert.equal(eng(['sync', '--check']).status, 0);
});

// Concurrent changes while sync runs are out of scope (a single actor); eng checks a folder again just before it writes or
// links into it and creates links only where nothing is, so these swaps leave at most the one folder the swapped mkdir made.
test('.claude swapped for a link outside the repo while sync runs: eng checks again before each link and links nothing there', () => {
  const { dir, eng } = repo();
  const shared = elsewhere();
  fs.mkdirSync(path.join(shared, 'skills')); fs.writeFileSync(path.join(shared, 'skills/grilling'), 'mine\n');
  const env = hook(`const mk = fs.mkdirSync; let done = false;
fs.mkdirSync = function (p, ...a) { if (!done && String(p) === at('.claude/skills')) { done = true; fs.renameSync(at('.claude'), at('saved-claude')); fs.symlinkSync(process.env.PROBE_OUTSIDE, at('.claude')); process.stderr.write('PROBE switched\\n'); } return mk.call(this, p, ...a); };`);
  const before = deep(shared);
  const r = eng(['sync'], { ...env, PROBE_OUTSIDE: shared });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stderr, /PROBE switched/, 'the swap happened after eng planned');
  assert.deepEqual(deep(shared), before, 'nothing written, replaced or deleted outside');
});

test('a source folder swapped for a link outside the repo while sync runs: eng writes no file there', () => {
  const { dir, eng } = repo();
  const shared = elsewhere();
  fs.mkdirSync(path.join(dir, '.agents/skills'), { recursive: true }); fs.mkdirSync(path.join(shared, 'skills'));
  const env = hook(`const mk = fs.mkdirSync; let done = false;
fs.mkdirSync = function (p, ...a) { if (!done && String(p).startsWith(at('.agents/skills') + path.sep)) { done = true; fs.renameSync(at('.agents'), at('saved-source')); fs.symlinkSync(process.env.PROBE_OUTSIDE, at('.agents')); process.stderr.write('PROBE switched\\n'); } return mk.call(this, p, ...a); };`);
  const r = eng(['sync'], { ...env, PROBE_OUTSIDE: shared });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stderr, /PROBE switched/);
  const made = Object.entries(deep(shared)).filter(([k]) => k !== '.' && k !== 'skills');
  assert.ok(made.every(([, v]) => v.startsWith('dir ')), 'no file or link outside');
  assert.ok(made.length <= 1, `at most the folder the swapped mkdir made: ${made.map(([k]) => k)}`);
});

test('an entry that appears after eng planned a link there is left alone: eng creates links exclusively', () => {
  const { dir, eng } = repo();
  const env = hook(`let done = false; const plant = p => { if (!done && String(p) === at('.claude/skills/grilling')) { done = true; fs.writeFileSync(p, 'developer racing file\\n'); } };
for (const f of ['rmSync', 'unlinkSync']) { const o = fs[f]; fs[f] = function (p, ...a) { plant(p); return o.call(this, p, ...a); }; }
const sl = fs.symlinkSync; fs.symlinkSync = function (t, p, ...a) { plant(p); return sl.call(this, t, p, ...a); };`);
  const r = eng(['sync'], env);
  assert.equal(r.status, 0, out(r));
  assert.ok(fs.lstatSync(path.join(dir, '.claude/skills/grilling')).isFile(), 'the developer file is still there, not a link');
  assert.equal(fs.readFileSync(path.join(dir, '.claude/skills/grilling'), 'utf8'), 'developer racing file\n');
  assert.match(r.stdout, /left \.claude\/skills\/grilling: /);
  assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills/retro')), '../../.agents/skills/retro', 'the rest are linked');
});

// PR #58 verdict 3: each test below is one of its four findings. eng writes only inside real folders in the repo, and a
// link is eng's only when its target is exactly the one eng writes.
const ESCAPES = { 'through ..': () => '../../.agents/skills/../../../eng-r4-outside/missing', 'through a linked folder in the source': (dir, ext) => { fs.symlinkSync(ext, path.join(dir, '.agents/skills/bridge')); return '../../.agents/skills/bridge/missing'; } };
for (const [how, target] of Object.entries(ESCAPES))
  test(`a developer's link whose target only starts like eng's and escapes ${how} is not eng's: sync neither replaces nor prunes it`, () => {
    const { dir, eng } = repo();
    assert.equal(eng(['sync']).status, 0);
    const t = target(dir, elsewhere());
    for (const n of ['grilling', 'mine']) { fs.rmSync(path.join(dir, '.claude/skills', n), { force: true }); fs.symlinkSync(t, path.join(dir, '.claude/skills', n)); }
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    for (const n of ['grilling', 'mine']) assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills', n)), t, `.claude/skills/${n} is untouched`);
    setSkills(dir, FEWER);
    assert.equal(eng(['sync']).status, 0);
    for (const n of ['grilling', 'mine']) assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills', n)), t, `.claude/skills/${n} survives dropping grilling`);
  });

test('a regular file named like a skill in a linked skills folder is not a skill the harnesses find', () => {
  const { dir, eng } = repo(doctorClean);
  const ext = elsewhere();
  fs.mkdirSync(path.join(ext, 'shared')); fs.writeFileSync(path.join(ext, 'shared/grilling'), 'not a skill\n');
  fs.mkdirSync(path.join(dir, '.claude')); fs.symlinkSync(path.join(ext, 'shared'), path.join(dir, '.claude/skills'));
  const r = eng(['sync']), c = eng(['sync', '--check']), d = doctor(eng);
  for (const x of [r, c, d]) { assert.equal(x.status, 0, out(x)); assert.match(x.stdout, /Through \.claude\/skills the harnesses find none of eng's/, out(x)); }
});

test('eng\'s source under a .eng linked outside the repo: sync writes no lock or anything else there, says so, and doctor passes', () => {
  const { dir, eng } = repo(c => { c.agents.skills_dir = '.eng/skills'; return doctorClean(c); });
  const ext = elsewhere();
  fs.symlinkSync(ext, path.join(dir, '.eng'));
  const before = deep(ext);
  const r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(deep(ext), before, 'nothing written outside');
  assert.match(r.stdout, /left \.eng is a symlink to .*eng did not write \.eng\/lock\.json\./);
  setSkills(dir, FEWER);
  assert.equal(eng(['sync']).status, 0);
  assert.equal(eng(['sync', '--check']).status, 0);
  const d = doctor(eng);
  assert.equal(d.status, 0, out(d));
  assert.match(d.stdout, /WARN \.eng is a symlink to .*eng did not write \.eng\/lock\.json\./);
  assert.deepEqual(deep(ext), before, 'nor on a later sync, check or doctor');
});

for (const parent of ['.claude', '.eng'])
  test(`eng init with the checks folder under a ${parent} linked outside the repo makes no folder there`, () => {
    const { dir, eng } = repo(c => { c.agents.skills_dir = `${parent}/skills`; c.verification.checks_dir = `${parent}/checks`; return c; });
    const ext = elsewhere();
    fs.symlinkSync(ext, path.join(dir, parent));
    const before = deep(ext);
    const r = eng(['init']);
    assert.equal(r.status, 0, out(r));
    assert.deepEqual(deep(ext), before, 'nothing made outside');
    assert.match(r.stdout, re(`left ${parent} is a symlink to ${ext}, so eng writes and deletes nothing through it.`));
    assert.match(r.stdout, re(`eng did not write ${parent}/checks.`));
  });

// ---------- 5. a container a check starts is outside eng's budget unless docker is given the limits ----------
// The container lint is a nudge: a text scan of common shell forms cannot parse shell, so it warns and never fails.
const CONTAINER_WARN = /WARN \.eng\/checks\/tla\.sh:4: \[container-unbounded\] Container without a memory and CPU limit/;
test('eng lint warns on a check\'s docker or podman run without both --memory and --cpus, never fails on it, and is quiet on one that has them', () => {
  const { eng, checks, dir } = repo();
  const lint = body => { fs.rmSync(path.join(dir, '.eng/checks'), { recursive: true, force: true }); checks({ tla: `#!/usr/bin/env bash\n# weight: heavy\n# budget: memory=2G workers=2 timeout=10m\n${body}\n` }); return eng(['lint']); };
  for (const bad of [
    'docker run --rm --name tlc-$$ tlc:1 java -Xmx1g -jar tla2tools.jar -workers 2 Spec.tla',
    'podman run --rm --memory 2g img true',
    'docker container run --rm --cpus 2 img true',
    'docker run --rm \\\n  --memory-swap 2g \\\n  --cpus 2 img true',
    'eng run -- docker run --rm img true',
    'docker run --rm --memory=128m --cpus=1 image true; docker run --rm image true',
    'docker run --rm --memory=128m --cpus=1 img true && podman run --rm img true',
    'docker run --rm --memory=128m --cpus=1 img true | docker run --rm img cat',
    'docker run --rm image echo --memory=128m --cpus=1',
    'docker run --rm image true # --memory=128m --cpus=1',
    'docker run --rm --memory=0 --cpus=1 img true',
    'out=$(docker run --rm img true)',
    'docker run --rm --memory=128m -m0 --cpus=1 img true',
    'docker run --rm -m128m --memory=0 --cpus=1 img true',
    'docker run --rm -m 128m -m 0 --cpus=1 img true',
    'docker run --rm --memory=128m --cpus=1 --cpus=0 img true',
    'docker run --rm 2>/dev/null img true',
    'cat <<EOF\nsample\nEOF\ndocker run --rm img true',
  ]) {
    const r = lint(bad);
    assert.equal(r.status, 0, `a warning, not a failure: ${bad}\n${out(r)}`);
    assert.match(r.stdout, bad.startsWith('cat') ? /tla\.sh:7: \[container-unbounded\]/ : CONTAINER_WARN, bad);
    assert.match(r.stdout, /eng lint: PASS .*warning/, bad);
  }
  for (const ok of [
    'docker run --rm --name tlc-$$ --memory 1536m --cpus 2 tlc:1 true',
    'podman run --rm -m=1g --cpus=1 img true',
    'docker run --rm \\\n  --name "tlc-$$" \\\n  --memory "${ENG_BUDGET_HEAP_MB}m" \\\n  --cpus "$ENG_BUDGET_WORKERS" \\\n  img true',
    'docker run --rm --memory=128m --cpus .5 image true',
    'docker run --rm -m128m --cpus=0.5 img true',
    'docker run --rm --memory 1g --cpus 1.25 img true',
    'docker run --rm -it -e A=1 -v "$PWD:/w" -m 1g --cpus=1 img sh -c "echo --x"',
    'docker run --rm --memory=128m --cpus=1 img true; docker run --rm -m 64m --cpus .5 img true',
    '# docker run --rm img (a comment)',
    'docker ps',
    'docker run --rm -m0 --memory=128m --cpus=1 img true',
    'docker run --rm 2>/dev/null -m128m --cpus=1 img true',
    'docker run --rm >out.log 2>&1 -m128m --cpus=1 img true',
    'docker run --rm > out.log 2> err.log < in.txt -m128m --cpus=1 img true',
    'docker run --rm >>out.log &>all.log -m128m --cpus=1 img true',
    "cat <<'EOF'\ndocker run --rm img true\nEOF",
    'cat <<EOF\ndocker run --rm img true\nEOF',
    'cat <<-END >notes.txt\n\tdocker run --rm img true\n\tEND\ndocker run --rm -m1g --cpus=1 img true',
  ]) {
    const r = lint(ok);
    assert.equal(r.status, 0, `${ok}\n${out(r)}`);
    assert.doesNotMatch(out(r), /container-unbounded/, ok);
  }
  const proofs = out(eng(['rules', 'prove'])).match(/(heavy-tool|container)-unbounded: \S+/g);
  assert.deepEqual(proofs, ['heavy-tool-unbounded: bites', 'container-unbounded: bites'], 'each built-in fixture proves its own rule');
});

test('the container warning never fails eng gate or eng doctor, and an unbounded java still fails lint and the gate', () => {
  const { eng, checks } = repo(c => ({ ...c, gates: { ...c.gates, required: ['lint'] } }));
  checks({ tla: '#!/usr/bin/env bash\n# weight: light\nexit 0\ndocker run --rm img true\n' });
  const lint = eng(['lint']);
  assert.equal(lint.status, 0, out(lint)); assert.match(lint.stdout, CONTAINER_WARN);
  const gate = eng(['gate']);
  assert.equal(gate.status, 0, out(gate));
  const warned = eng(['doctor']);
  assert.match(warned.stdout, CONTAINER_WARN, 'doctor reports the container warning');
  checks({ tla: '#!/usr/bin/env bash\n# weight: light\nexit 0\ndocker run --rm -m1g --cpus=1 img true\n' });
  const clean = eng(['doctor']);
  assert.doesNotMatch(out(clean), /container-unbounded/);
  assert.equal(warned.status, clean.status, `doctor exits the same with and without the warning\n${out(warned)}\n${out(clean)}`);
  checks({ tla: '#!/usr/bin/env bash\n# weight: light\nexit 0\njava -jar tla2tools.jar Spec.tla\n' });
  const java = eng(['lint']);
  assert.equal(java.status, 1, out(java)); assert.match(java.stderr, /tla\.sh:4: \[heavy-tool-unbounded\] Heavy tool without a bound/);
  assert.equal(eng(['gate']).status, 1, 'the gate still fails on an unbounded JVM');
});

test('the catalog and the rendered budget text give the container pattern, and say docker enforces it, not eng', () => {
  const cat = YAML.parse(fs.readFileSync(path.join(PKG, 'standard/checks.yml'), 'utf8'));
  const c = cat.containers;
  assert.ok(c, 'standard/checks.yml has a containers entry');
  for (const flag of ['--memory', '--cpus', '--rm', '--name', "trap 'docker rm -f"]) assert.ok(c.pattern.includes(flag), `the pattern has ${flag}`);
  assert.match(c.enforced_by, /docker/i); assert.doesNotMatch(c.enforced_by, /eng enforces/i);
  const { dir, eng } = repo();
  assert.equal(eng(['sync']).status, 0);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /docker run.*--memory.*--cpus/);
  assert.match(agents, /docker (enforces|applies) (the|those) limits?/i);
  assert.match(agents, /trap 'docker rm -f/);
  for (const text of [agents, c.why]) {
    assert.doesNotMatch(text, /a timeout or a cancel removes it|when the check exits or is stopped|on a TERM or INT/, 'no claim that the trap runs when eng stops the check (PR #57 verdict 3)');
    assert.match(text, /eng does not\s+promise the trap runs/, 'says eng does not promise cleanup when it stops a check');
  }
  assert.match(agents, /--name "\$ENG_BUDGET_UNIT"/, 'names the container with the id eng exports to the check');
  assert.match(agents, /a wrapper function or a variable hides/, 'states what the lint cannot see');
  assert.match(agents, /`eng lint` and `eng doctor` warn.*never fails? (lint|the gate)/, 'says the container lint only warns');
  assert.match(agents, /a text check of common forms/, 'says the lint is a text check');
});
