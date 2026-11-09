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
// Every file under dir (symlinks as links), with its bytes or link target: what "wrote nothing" compares.
function snapshot(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = path.join(rel, e.name), abs = path.join(dir, p);
      if (p === '.git') continue;
      if (e.isSymbolicLink()) out[p] = `-> ${fs.readlinkSync(abs)}`;
      else if (e.isDirectory()) { out[`${p}/`] = 'dir'; walk(p); }
      else out[p] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk('.');
  return out;
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

// ---------- 4. a symlinked skills or agents folder: eng follows it inside the repo and leaves it alone outside ----------
// Core decision nd70ke343v7gc0eakdejg7m5f18hx1p9: eng manages repo-local things only. 0.17.1 refused any symlinked
// .claude, .claude/skills or .claude/agents; a developer who shares one skills folder across harnesses could not adopt.
const KINDS = {
  '.claude/skills': { own: '../.agents/skills', inside: '../tools/codex/skills', real: { skills: 'tools/codex/skills' } },
  '.claude/agents': { own: '../.agents/agents', inside: '../tools/codex/agents', real: { agents: 'tools/codex/agents' } },
  '.claude': { own: '.agents', inside: 'tools/claude', real: { skills: 'tools/claude/skills', agents: 'tools/claude/agents' } },
};
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
const groupsOf = link => link === '.claude' ? ['skills', 'agents'] : [link.split('/')[1]];
const pick = (snap, prefixes) => Object.fromEntries(Object.entries(snap).filter(([k]) => prefixes.some(p => k === p || k.startsWith(`${p}/`))));
const reaches = (dir, l, src) => fs.realpathSync(path.join(dir, l)) === fs.realpathSync(path.join(dir, src));

for (const [link, k] of Object.entries(KINDS)) {
  test(`case 1: ${link} links to eng's own source folder: the ${groupsOf(link).join(' and ')} stay real, eng writes no link into them, and Claude Code reaches each`, () => {
    const { dir, eng } = repo();
    fs.mkdirSync(path.join(dir, '.agents/skills'), { recursive: true }); fs.mkdirSync(path.join(dir, '.agents/agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, path.dirname(link)), { recursive: true });
    fs.symlinkSync(k.own, path.join(dir, link));
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    for (const g of groupsOf(link)) {
      const names = fs.readdirSync(path.join(dir, SOURCE[g]));
      assert.ok(names.length >= 2, `${SOURCE[g]} has eng's ${g}`);
      for (const n of names) {
        const st = fs.lstatSync(path.join(dir, SOURCE[g], n));
        assert.ok(!st.isSymbolicLink() && (g === 'skills' ? st.isDirectory() : st.isFile()), `${SOURCE[g]}/${n} is still a real ${g === 'skills' ? 'folder' : 'file'}`);
        if (g === 'skills') assert.ok(fs.existsSync(path.join(dir, SOURCE[g], n, 'SKILL.md')), `${n}/SKILL.md intact`);
        assert.ok(reaches(dir, `.claude/${g}/${n}`, `${SOURCE[g]}/${n}`), `.claude/${g}/${n} reaches ${SOURCE[g]}/${n}`);
      }
    }
    const c = eng(['sync', '--check']);
    assert.equal(c.status, 0, out(c));
    assert.match(eng(['sync']).stdout, /eng sync: no changes/);
    for (const g of groupsOf(link)) assert.match(eng(['doctor']).stdout, new RegExp(`ok   \\.claude/${g} resolves to \\.agents/${g}`));
  });

  test(`case 2: ${link} links to another folder in the repo: eng adds its links beside the folder's own entries, never replaces one, and prunes only its own`, () => {
    const { dir, eng } = repo();
    fs.mkdirSync(path.join(dir, k.inside.replace(/^\.\.\//, '')), { recursive: true });
    for (const [g, real] of Object.entries(k.real)) plantForeign(path.join(dir, real), g);
    fs.mkdirSync(path.join(dir, path.dirname(link)), { recursive: true });
    fs.symlinkSync(k.inside, path.join(dir, link));
    const foreign = Object.entries(k.real).flatMap(([g, real]) => FOREIGN[g].map(n => `${real}/${n}`));
    const mine = pick(snapshot(dir), foreign);
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    for (const [g, real] of Object.entries(k.real)) {
      for (const n of fs.readdirSync(path.join(dir, SOURCE[g])).filter(n => !FOREIGN[g].includes(n))) {
        assert.equal(fs.readlinkSync(path.join(dir, real, n)), `../../../${SOURCE[g]}/${n}`, `${real}/${n} links relative to ${real}`);
        assert.ok(reaches(dir, `.claude/${g}/${n}`, `${SOURCE[g]}/${n}`), `.claude/${g}/${n} reaches ${SOURCE[g]}/${n}`);
      }
      for (const n of FOREIGN[g].filter(n => fs.existsSync(path.join(PKG, 'vendor/pstack/agents', n)) || n === 'grilling'))
        assert.match(r.stdout, new RegExp(`left \\.claude/${g}/${n}: ${real}/${n} is a (folder|file) that eng did not make, so eng leaves it`));
    }
    assert.deepEqual(pick(snapshot(dir), foreign), mine, "the folder's own entries are untouched");
    const c = eng(['sync', '--check']);
    assert.equal(c.status, 0, out(c));
    assert.match(eng(['sync']).stdout, /eng sync: no changes/);
    const cfg = YAML.parse(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8'));
    cfg.agents.skills = [...cfg.agents.skills.filter(s => s !== 'eng/eng-retro' && s !== 'pstack/*'), 'pstack/statechart', 'pstack/create-formal-verification-skill'];
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(cfg));
    const p = eng(['sync']);
    assert.equal(p.status, 0, out(p));
    for (const [g, real] of Object.entries(k.real)) {
      const left = fs.readdirSync(path.join(dir, real)).filter(n => !FOREIGN[g].includes(n));
      assert.deepEqual(left.sort(), fs.readdirSync(path.join(dir, SOURCE[g])).filter(n => !FOREIGN[g].includes(n)).sort(), `${real} holds eng links only for what the config still renders`);
      if (g === 'skills') assert.ok(!left.includes('eng-retro'), 'eng-retro unlinked');
      if (g === 'agents') assert.deepEqual(left, [], 'comment-sicko.md unlinked');
    }
    assert.deepEqual(pick(snapshot(dir), foreign), mine, 'pruning removed none of them');
    assert.equal(eng(['sync', '--check']).status, 0);
  });

  test(`case 3: ${link} links outside the repo: eng writes and deletes nothing there, says where its ${groupsOf(link).join(' and ')} are, and doctor warns`, () => {
    const { dir, eng } = repo();
    const shared = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-shared-skills-')); scratch.push(shared);
    if (link === '.claude') { plantForeign(path.join(shared, 'skills'), 'skills'); plantForeign(path.join(shared, 'agents'), 'agents'); fs.writeFileSync(path.join(shared, 'settings.json'), '{"mine":true}\n'); }
    else plantForeign(shared, groupsOf(link)[0]);
    fs.mkdirSync(path.join(dir, path.dirname(link)), { recursive: true });
    fs.symlinkSync(shared, path.join(dir, link));
    const before = snapshot(shared);
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    const real = fs.realpathSync(shared);
    for (const g of groupsOf(link)) {
      const where = link === '.claude' ? path.join(real, g) : real;
      assert.ok(r.stdout.includes(`left .claude/${g} resolves to ${where}, outside this repo, so eng writes and deletes nothing there. eng's ${g === 'skills' ? 'skills' : 'subagents'} are in ${SOURCE[g]}`), out(r));
    }
    if (link === '.claude') assert.ok(r.stdout.includes(`left .claude/settings.json resolves to ${path.join(real, 'settings.json')}, outside this repo, so eng does not write it.`), out(r));
    const c = eng(['sync', '--check']);
    assert.equal(c.status, 0, out(c));
    const d = eng(['doctor']);
    for (const g of groupsOf(link)) assert.match(d.stdout, new RegExp(`WARN \\.claude/${g} resolves to .*outside this repo`));
    assert.doesNotMatch(out(d), /FAIL.*\.claude/);
    assert.deepEqual(snapshot(shared), before, 'the shared folder: same files, bytes and links after sync, sync --check and doctor');
  });
}

test('a real folder or file where eng wants a link is never deleted: eng leaves it, says so, and links the rest', () => {
  const { dir, eng } = repo();
  fs.mkdirSync(path.join(dir, '.claude/skills/grilling'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude/skills/grilling/SKILL.md'), 'my grilling\n');
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude/agents/poteto-agent.md'), 'my agent\n');
  const mine = pick(snapshot(dir), ['.claude/skills/grilling', '.claude/agents/poteto-agent.md']);
  const r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(pick(snapshot(dir), ['.claude/skills/grilling', '.claude/agents/poteto-agent.md']), mine, 'both untouched');
  assert.match(r.stdout, /left \.claude\/skills\/grilling: \.claude\/skills\/grilling is a folder that eng did not make, so eng leaves it/);
  assert.match(r.stdout, /left \.claude\/agents\/poteto-agent\.md: \.claude\/agents\/poteto-agent\.md is a file that eng did not make/);
  assert.equal(fs.readlinkSync(path.join(dir, '.claude/skills/retro')), '../../.agents/skills/retro');
  assert.equal(eng(['sync', '--check']).status, 0);
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

// PR #58 verdict 1: each test below is one of its reproductions.
const elsewhere = () => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-elsewhere-')); scratch.push(d); return d; };
// A --require hook that changes the disk at one fs call, the way a developer or another process could while sync runs.
const hook = body => { const f = path.join(elsewhere(), 'hook.cjs'); fs.writeFileSync(f, `const fs = require('fs'), path = require('path'), at = p => path.join(process.cwd(), p);\n${body}\n`); return { NODE_OPTIONS: `--require=${f}` }; };
const FEWER = ['eng/eng-retro', 'pstack/statechart', 'pstack/create-formal-verification-skill'];
const setSkills = (dir, skills) => { const c = YAML.parse(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8')); c.agents.skills = skills; fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c)); };

test('a link folder swapped for a link outside the repo while sync runs: eng checks again before each link and writes nothing there', () => {
  const { dir, eng } = repo();
  const shared = elsewhere();
  fs.mkdirSync(path.join(dir, 'harness/skills'), { recursive: true }); fs.mkdirSync(path.join(shared, 'skills'));
  fs.writeFileSync(path.join(shared, 'skills/grilling'), 'mine\n');
  fs.mkdirSync(path.join(dir, '.claude')); fs.symlinkSync('../harness/skills', path.join(dir, '.claude/skills'));
  const env = hook(`const mk = fs.mkdirSync; let done = false;
fs.mkdirSync = function (p, ...a) { if (!done && String(p) === at('harness/skills')) { done = true; fs.renameSync(at('harness'), at('saved-harness')); fs.symlinkSync(process.env.PROBE_OUTSIDE, at('harness')); process.stderr.write('PROBE switched\\n'); } return mk.call(this, p, ...a); };`);
  const before = snapshot(shared);
  const r = eng(['sync'], { ...env, PROBE_OUTSIDE: shared });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stderr, /PROBE switched/, 'the swap happened after eng planned');
  assert.deepEqual(snapshot(shared), before, 'nothing written, replaced or deleted outside');
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
  assert.deepEqual(Object.entries(snapshot(shared)).filter(([, v]) => v !== 'dir'), [], 'no file or link outside (the folder the swapped mkdir itself made is the stated concurrency limit)');
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
    if (!remove) assert.match(r.stdout, new RegExp(`left ${l.replace(/[./]/g, '\\$&')}: .* is a link to ${mine.replace(/[./]/g, '\\$&')} that eng did not make`));
    assert.equal(eng(['sync', '--check']).status, 0);
  });

for (const g of ['skills', 'agents'])
  test(`.claude/${g} links to .agents/${g}, which links outside the repo: outside wins, so sync, --check and doctor agree it is case 3`, () => {
    const { dir, eng } = repo();
    const shared = elsewhere();
    plantForeign(shared, g);
    fs.mkdirSync(path.join(dir, '.agents')); fs.mkdirSync(path.join(dir, '.claude'));
    fs.symlinkSync(shared, path.join(dir, `.agents/${g}`)); fs.symlinkSync(`../.agents/${g}`, path.join(dir, `.claude/${g}`));
    const before = snapshot(shared);
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, new RegExp(`left \\.claude/${g} resolves to .*, outside this repo`));
    const c = eng(['sync', '--check']);
    assert.equal(c.status, 0, out(c));
    const d = eng(['doctor']);
    assert.match(d.stdout, new RegExp(`WARN \\.claude/${g} resolves to .*outside this repo`));
    assert.doesNotMatch(d.stdout, /sees them through it/, 'doctor claims no reachability');
    assert.deepEqual(snapshot(shared), before);
  });

for (const [folder, kind] of [['.claude', 'loop'], ['.claude/skills', 'loop'], ['.claude/agents', 'loop'], ['.claude', 'dangling']])
  test(`${folder} as a ${kind === 'loop' ? 'link to itself' : 'dangling link into the repo'}: sync says so and finishes, with no crash`, () => {
    const { dir, eng } = repo();
    fs.mkdirSync(path.join(dir, path.dirname(folder)), { recursive: true });
    fs.symlinkSync(kind === 'loop' ? path.basename(folder) : 'missing', path.join(dir, folder));
    const r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    assert.ok(fs.existsSync(path.join(dir, '.eng/lock.json')), 'sync wrote its lock');
    if (kind === 'loop') assert.match(r.stdout, new RegExp(`left ${folder.replace(/[./]/g, '\\$&')}.* cannot be resolved`));
    else assert.ok(fs.existsSync(path.join(dir, 'missing/settings.json')), '.claude/settings.json is written where .claude resolves');
    const c = eng(['sync', '--check']);
    assert.equal(c.status, 0, out(c));
    assert.doesNotMatch(out(eng(['doctor'])), /\n\s+at .*\.m?js:\d+/, 'doctor does not crash');
  });

test("an empty folder the developer made in eng's skills source is kept: cleanup removes only folders eng rendered", () => {
  const { dir, eng } = repo();
  fs.mkdirSync(path.join(dir, '.agents/skills/mine'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude')); fs.symlinkSync('../.agents/skills', path.join(dir, '.claude/skills'));
  const r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.ok(fs.lstatSync(path.join(dir, '.agents/skills/mine')).isDirectory(), '.agents/skills/mine is still there');
  setSkills(dir, FEWER);
  assert.equal(eng(['sync']).status, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.agents/skills/grilling')), 'a skill folder eng rendered and pruned is removed');
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/mine')));
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
