// R3b (8 Nov 2026): a Codex agent onboarded a Python repo from the docs alone. Four defects hurt every new adopter:
// per-command --help ran the command, the rendered text claimed an agent deny list Codex never gets, eng's own installed
// skills made doctor demand a Bun cache, and a reduced config crashed render with a TypeError.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
const R = await import('../lib/render.mjs');
const { renderAll } = R, renderErrors = R.renderErrors ?? (() => []);

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs'), TPL = path.join(ROOT, 'templates/eng.config.yml');
const base = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-honest-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const xdg = path.join(base, 'xdg');
const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_STANDARD_SOURCE: ROOT, ENG: `${process.execPath} ${ENG}`, ENG_TMP: '', ENG_TMP_BASE: '', ENG_SCRATCH: '', ENG_BASE: '', ENG_PR: '', GITHUB_ACTIONS: '', BUILDKITE: '' };
const eng = (dir, ...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env, timeout: 60000 });
const git = (dir, c) => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const out = r => r.stdout + r.stderr;
let n = 0;
function repo(files = { 'README.md': 'x\n' }) {
  const dir = path.join(base, `repo-${n++}`); fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init -q -b main'); git(dir, 'config user.email t@t'); git(dir, 'config user.name t');
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
  git(dir, 'add -A'); git(dir, 'commit -qm base');
  return dir;
}
const template = () => YAML.parse(fs.readFileSync(TPL, 'utf8'));

// ---------- 1. help is inert ----------
function snapshot(dir) {
  const h = crypto.createHash('sha256');
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = path.join(d, f.name), rel = path.relative(dir, p);
    if (rel === '.git/index') continue;
    if (f.isSymbolicLink()) h.update(`L ${rel} ${fs.readlinkSync(p)}\n`);
    else if (f.isDirectory()) { h.update(`D ${rel}\n`); walk(p); }
    else h.update(`F ${rel} ${fs.statSync(p).mode} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}\n`);
  } };
  walk(dir);
  return { status: git(dir, 'status --porcelain --ignored'), config: git(dir, 'config --list --local'), tree: h.digest('hex'), xdg: fs.existsSync(xdg) };
}
const HELP_CALLS = [
  ['init'], ['sync'], ['sync', '--check'], ['lint'], ['run'], ['run', '--by', 'x'], ['run', '--keep'], ['run', 'down', 'd'], ['run', '--here'], ['run', 'test'],
  ['verdict'], ['verdict', 'PASS', '--by', 'x'], ['verdict', 'check'], ['verdict', 'status', '--pr', '1'], ['e2e'], ['e2e', '--required'], ['e2e', '--flake-check'],
  ['rules'], ['rules', 'prove'], ['gate'], ['gate', 'checks'], ['merge'], ['merge', 'gate'], ['merge', 'post'], ['doctor'], ['doctor', '--launch'],
];

test('every command and subcommand: --help, -h and `eng help <cmd>` print its usage, exit 0 and leave the repo, its git config and the caches untouched', () => {
  const dir = repo();
  const before = snapshot(dir);
  const bad = [];
  for (const call of HELP_CALLS) for (const argv of [[...call, '--help'], [...call, '-h'], ['help', call[0]]]) {
    const r = eng(dir, ...argv), now = snapshot(dir);
    if (r.status !== 0) bad.push(`eng ${argv.join(' ')}: exit ${r.status}: ${out(r).trim().split('\n')[0]}`);
    else if (!new RegExp(`usage: eng ${call[0]}\\b`).test(r.stdout)) bad.push(`eng ${argv.join(' ')}: no "usage: eng ${call[0]}" in ${JSON.stringify(r.stdout.slice(0, 80))}`);
    for (const k of Object.keys(before)) if (now[k] !== before[k]) bad.push(`eng ${argv.join(' ')}: changed ${k}`);
    if (bad.length) break;
  }
  assert.deepEqual(bad, []);
  assert.deepEqual(snapshot(dir), before);
});

test('help stops only at eng\'s own options: a --help after `--` belongs to the command eng runs', () => {
  const dir = repo();
  const r = eng(dir, 'run', '--here', '--', 'sh', '-c', 'echo ran', '--help');
  assert.doesNotMatch(r.stdout, /usage: eng run/);
  assert.equal(eng(dir, 'help').status, 0, 'eng help alone prints the command table');
  assert.equal(eng(dir, 'help', 'nope').status, 1, 'help for an unknown command fails');
});

// ---------- 2. coverage claims are true per harness ----------
const renderText = harnesses => { const c = template(); c.agents.harnesses = harnesses; const f = renderAll(c, null); return { agents: f['AGENTS.md'], shipping: f['SHIPPING.md'], files: f }; };

test('codex-only: no rendered text claims an agent deny list, and it names codex as having none', () => {
  const { agents, shipping, files } = renderText(['codex']);
  assert.equal(files['.claude/settings.json'], undefined);
  for (const [name, t] of [['AGENTS.md', agents], ['SHIPPING.md', shipping]]) {
    assert.doesNotMatch(t, /the agent deny list|deny lists only|\(deny list\)|Claude Code deny list/i, `${name} claims a deny list codex does not get`);
  }
  assert.match(agents, /codex: no agent deny list/);
  assert.match(shipping, /codex: no agent deny list/);
});

test('claude-code with codex: the deny list is named as Claude Code\'s, and codex is named as without one', () => {
  const { agents, shipping, files } = renderText(['claude-code', 'codex']);
  assert.ok(files['.claude/settings.json']);
  assert.doesNotMatch(agents + shipping, /agent deny lists only|the agent deny list/);
  assert.match(agents, /Claude Code deny list/); assert.match(shipping, /Claude Code deny list/);
  assert.match(agents, /codex: no agent deny list/);
  const only = renderText(['claude-code']);
  assert.doesNotMatch(only.agents + only.shipping, /no agent deny list/, 'claude-code alone names no gap');
});

test('eng doctor prints one line per selected harness naming the protections it does not get', () => {
  const c = template(); c.project.name = 'harness-repo'; c.agents.harnesses = ['codex']; delete c.constraints; delete c.agents.rules; c.laws.enabled = false;
  const dir = repo({ 'README.md': 'x\n', 'eng.config.yml': YAML.stringify(c) });
  assert.equal(eng(dir, 'sync').status, 0);
  let o = out(eng(dir, 'doctor'));
  assert.match(o, /codex: no agent deny list; --no-verify and --admin are guarded by this text only/);
  assert.doesNotMatch(o, /claude-code:/);
  c.agents.harnesses = ['claude-code', 'codex']; c.agents.post_edit_command = 'true';
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  assert.equal(eng(dir, 'sync').status, 0);
  o = out(eng(dir, 'doctor'));
  assert.match(o, /ok {3}claude-code: agent deny list and post-edit hook in \.claude\/settings\.json/);
  assert.match(o, /codex: no agent deny list.*no post-edit hook/);
});

// ---------- 3. tool detection counts the product, not eng's own install ----------
test('doctor: a Python repo with eng\'s skills installed needs no Bun cache; its own top-level bun.lock still does', () => {
  const c = template(); c.project.name = 'py-repo'; delete c.constraints; delete c.agents.rules; c.laws.enabled = false; delete c.hygiene.caches.bun;
  const dir = repo({ 'pyproject.toml': '[project]\nname = "py"\n', 'src/py/__init__.py': '', 'eng.config.yml': YAML.stringify(c) });
  assert.equal(eng(dir, 'sync').status, 0);
  assert.ok(fs.readdirSync(path.join(dir, c.agents.skills_dir), { recursive: true }).some(f => /bun\.lockb?$/.test(f)), 'the installed skills carry a bun.lock');
  git(dir, 'add -A'); git(dir, 'commit -qm eng');
  let r = eng(dir, 'doctor');
  assert.doesNotMatch(out(r), /hygiene\.caches\.bun/);
  assert.equal(r.status, 0, out(r));
  fs.writeFileSync(path.join(dir, 'bun.lock'), '{}\n'); git(dir, 'add -A'); git(dir, 'commit -qm bun');
  r = eng(dir, 'doctor');
  assert.match(out(r), /FAIL hygiene\.caches\.bun/);
  assert.equal(r.status, 1);
});

// ---------- 4. a reduced config fails with a message, not a crash ----------
test('eng sync on a config without stack.frameworks names the key and the template default; no TypeError', () => {
  const c = template(); delete c.stack.frameworks;
  const dir = repo({ 'eng.config.yml': YAML.stringify(c) });
  const r = eng(dir, 'sync');
  assert.equal(r.status, 1);
  assert.doesNotMatch(out(r), /TypeError|Cannot read properties/);
  assert.match(out(r), /stack\.frameworks is missing.*template default/);
});

test('a minimal config gets a config error for each shape render reads, never a TypeError', () => {
  const dir = repo({ 'eng.config.yml': YAML.stringify({ version: 1, merge: { owner: 'me', command: 'gh pr merge' }, gates: { skipped_is_failed: true } }) });
  const r = eng(dir, 'sync');
  assert.equal(r.status, 1);
  assert.doesNotMatch(out(r), /TypeError|Cannot read properties|ERR_INVALID_ARG_TYPE/);
  for (const k of ['project', 'stack', 'agents', 'gates.required']) assert.match(out(r), new RegExp(`${k.replace('.', '\\.')} is missing`));
});

test('removing any one key the template sets (to depth 3) gives render errors or a clean render, never a throw', () => {
  const tpl = template(), paths = [];
  const walk = (o, p) => { if (p.length) paths.push(p); if (p.length < 3 && o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) walk(o[k], [...p, k]); };
  walk(tpl, []);
  const thrown = [];
  for (const p of paths) {
    const c = structuredClone(tpl); let o = c; for (const k of p.slice(0, -1)) o = o[k]; delete o[p.at(-1)];
    if (renderErrors(c).length) continue;
    try { renderAll(c, null); } catch (e) { thrown.push(`${p.join('.')}: ${e.message}`); }
  }
  assert.ok(paths.length > 100);
  assert.deepEqual(thrown, []);
});

// PR #53 verdict 1: in protected mode the pre-push hook lets every feature-branch rewrite through, so for a harness with no deny
// list nothing local stops a raw force-push of a feature branch. The text and doctor must say so, in both rewrite modes.
test('rewrite modes: a harness with no deny list is told the truth about raw force-pushes, in never and in protected mode', () => {
  const cfg = (harnesses, mode) => { const c = template(); c.agents.harnesses = harnesses; c.git = { ...(c.git ?? {}), rewrite_pushed: mode }; return c; };
  for (const hs of [['codex'], ['claude-code', 'codex']]) {
    const never = cfg(hs, 'never'), prot = cfg(hs, 'protected');
    const lineOf = c => R.harnessLines(c).find(l => l.what.startsWith('codex:')).what;
    assert.match(lineOf(never), /a raw force-push by \.githooks\/pre-push only \(which --no-verify skips\)/, `${hs}: never mode, the hook blocks any non-fast-forward push`);
    assert.doesNotMatch(lineOf(prot), /a raw force-push by \.githooks\/pre-push only/, `${hs}: protected mode must not claim the hook guards feature branches`);
    assert.match(lineOf(prot), /a raw force-push of a feature branch has no local guard/, `${hs}: protected mode names the gap`);
    const ship = renderAll(prot, null)['SHIPPING.md'], agents = renderAll(prot, null)['AGENTS.md'];
    assert.doesNotMatch(ship, /so the git hooks are their only local guard\)/, `${hs}: protected SHIPPING.md must not imply the hooks guard feature branches`);
    assert.match(ship, /nothing local stops a raw force-push of a feature branch/, `${hs}: protected SHIPPING.md names the gap`);
    assert.match(agents, /no local guard on feature branches/, `${hs}: protected AGENTS.md rule table names the gap`);
    assert.match(renderAll(never, null)['SHIPPING.md'], /so the git hooks are their only local guard\)/, `${hs}: never mode keeps its accurate wording`);
  }
  // PR #53 verdict 2: protected mode with no harness at all has no deny list either; the hooks still guard protected refs only.
  const none = renderAll(cfg([], 'protected'), null);
  assert.doesNotMatch(none['SHIPPING.md'], /`\.githooks\/pre-rebase` enforce this locally\./, 'protected, no harness: no claim of full local enforcement');
  assert.match(none['SHIPPING.md'], /enforce this locally for protected branches and tags; there is no agent deny list, so nothing local stops a raw force-push of a feature branch/);
  assert.match(none['AGENTS.md'], /no agent deny list, so no local guard on feature branches/);
  const claude = renderAll(cfg(['claude-code'], 'protected'), null);
  assert.match(claude['SHIPPING.md'], /enforce this locally for protected branches and tags; the Claude Code deny list blocks a raw force-push on any branch \(common forms only/, 'protected, claude-code only: the deny list covers feature branches');
  assert.doesNotMatch(claude['SHIPPING.md'] + claude['AGENTS.md'], /no local guard|nothing local stops/, 'protected, claude-code only: no gap to name');
});

// PR #53 verdict 3: every claim that credits the Claude Code deny list says it catches the common forms only, and the rebase
// hook's limits are named, in both modes.
test('every claim that credits the Claude Code deny list or the rebase hook names its limit', () => {
  for (const mode of ['never', 'protected']) {
    const c = template(); c.agents.harnesses = ['claude-code', 'codex']; c.git = { ...(c.git ?? {}), rewrite_pushed: mode };
    const f = renderAll(c, null), text = f['AGENTS.md'] + '\n' + f['SHIPPING.md'];
    const credits = text.split('\n').filter(l => /Claude Code deny list/.test(l));
    assert.ok(credits.length > 0, `${mode}: some line credits the deny list`);
    for (const l of credits) assert.match(l, /common forms only: a flag later on the line or bundled short flags such as `-vf` get through/, `${mode}: deny-list claim without its limit: ${l}`);
    const rebase = f['AGENTS.md'].split('\n').find(l => /\.githooks\/pre-rebase/.test(l) && l.startsWith('|'));
    assert.match(rebase, mode === 'never' ? /only when the branch has an upstream/ : /protected branches only\); the guarded-tool rule is this text only/, `${mode}: ${rebase}`);
  }
});
