// eng never writes into the harness skill folders (Matt, 9 Nov 2026; Core nd70ke343v7gc0eakdejg7m5f18hx1p9). Developers
// and other tools own .claude/skills and .claude/agents, so eng only reads them and reports what Claude Code cannot see.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const out = r => r.stdout + r.stderr;
const ROOT_USER = process.getuid?.() === 0;
const scratch = [];
// A test makes entries unreadable; give every folder back its x and r bits so the scratch dirs can be removed.
const unlock = d => { try { const st = fs.lstatSync(d); if (st.isDirectory()) { fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d)) unlock(path.join(d, e)); } else if (st.isFile()) fs.chmodSync(d, 0o644); } catch {} };
after(() => scratch.forEach(d => { unlock(d); fs.rmSync(d, { recursive: true, force: true }); }));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); scratch.push(d); return d; };

// The template config, with nothing that makes eng doctor fail for another reason, synced once.
function repo() {
  const dir = tmp('eng-harness-');
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
  c.gates.required = []; c.agents.rules = []; c.constraints = { rules: [] };
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base');
  const eng = args => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ENG_STANDARD_SOURCE: PKG } });
  const s = eng(['sync']); assert.equal(s.status, 0, out(s));
  const skills = fs.readdirSync(path.join(dir, '.agents/skills')).filter(n => fs.existsSync(path.join(dir, '.agents/skills', n, 'SKILL.md'))).sort();
  const agents = fs.readdirSync(path.join(dir, '.agents/agents')).sort();
  return { dir, eng, skills, agents, total: skills.length + agents.length, file: p => path.join(dir, p) };
}

// Every entry at and under p, read with lstat only: type, mode, size, inode, mtime, a link's target, a regular file's
// bytes. A link is never followed and a FIFO never opened, so the snapshot itself cannot block or escape.
function snapshot(p) {
  const shot = {};
  const walk = (abs, rel) => {
    let st; try { st = fs.lstatSync(abs); } catch (e) { shot[rel] = e.code; return; }
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isFIFO() ? 'fifo' : 'other';
    const e = { kind, mode: st.mode, size: st.size, ino: st.ino, mtime: st.mtimeMs };
    if (kind === 'link') e.to = fs.readlinkSync(abs);
    if (kind === 'file') { try { e.bytes = fs.readFileSync(abs, 'utf8'); } catch (err) { e.bytes = err.code; } }
    shot[rel] = e;
    if (kind === 'dir') { let names; try { names = fs.readdirSync(abs).sort(); } catch (err) { e.list = err.code; return; } for (const n of names) walk(path.join(abs, n), `${rel}/${n}`); }
  };
  walk(p, '.');
  return shot;
}
const claudeFolders = r => ({ skills: snapshot(r.file('.claude/skills')), agents: snapshot(r.file('.claude/agents')) });

const LINE = /^ {2}(ok {2}|WARN) claude-code: (all \d+|\d+ of \d+) eng skills and subagents .*$/m;
const report = res => (out(res).match(LINE) ?? [''])[0];
const allVisible = r => new RegExp(`ok {3}claude-code: all ${r.total} eng skills and subagents are visible in \\.claude/skills and \\.claude/agents`);
const notVisible = (r, n) => new RegExp(`WARN claude-code: ${n} of ${r.total} eng skills and subagents are not visible in \\.claude/skills or \\.claude/agents`);
const LINK_SKILLS = 'ln -s ../.agents/skills .claude/skills', LINK_AGENTS = 'ln -s ../.agents/agents .claude/agents';
const ADD = d => `add the missing entries to .claude/${d}, or point .claude/${d} at .agents/${d}`;

// sync, sync --check, doctor and init: each exits 0 within its timeout, prints the expected report (sync and doctor),
// and leaves .claude/skills, .claude/agents and every extra folder byte for byte, inode and mtime as they were.
function proveReadOnly(r, expect, extra = []) {
  const before = claudeFolders(r), elsewhere = extra.map(snapshot);
  for (const args of [['sync'], ['sync', '--check'], ['doctor'], ['init']]) {
    const res = r.eng(args);
    assert.equal(res.signal, null, `eng ${args.join(' ')} did not hang: ${out(res).slice(-2000)}`);
    assert.equal(res.status, 0, `eng ${args.join(' ')} exits 0: ${out(res).slice(-3000)}`);
    if (args[0] === 'sync' && args.length === 1 || args[0] === 'doctor') for (const re of [].concat(expect)) assert.match(report(res), re, `eng ${args.join(' ')}: ${report(res) || out(res).slice(-2000)}`);
    if (args[1] === '--check') assert.equal(report(res), '', '--check does not read the harness folders');
    assert.doesNotMatch(out(res), /linked \.claude|unlinked \.claude/);
    assert.deepEqual(claudeFolders(r), before, `eng ${args.join(' ')} left .claude/skills and .claude/agents untouched`);
    extra.forEach((d, i) => assert.deepEqual(snapshot(d), elsewhere[i], `eng ${args.join(' ')} left ${d} untouched`));
  }
}

test('a plain repo: sync creates nothing in .claude/skills or .claude/agents, and sync and doctor WARN with the link fix', () => {
  const r = repo();
  assert.ok(!fs.existsSync(r.file('.claude/skills')), 'the first sync made no .claude/skills');
  assert.ok(!fs.existsSync(r.file('.claude/agents')), 'the first sync made no .claude/agents');
  assert.ok(fs.existsSync(r.file('.claude/settings.json')), 'other .claude files still render');
  proveReadOnly(r, [notVisible(r, r.total), new RegExp(`Fix: ${LINK_SKILLS}; ${LINK_AGENTS}$`)]);
  const doc = r.eng(['doctor']);
  assert.equal(doc.status, 0, out(doc)); assert.match(doc.stdout, /eng doctor: PASS/);
});

test('per-skill links an earlier eng made survive sync untouched, stale and odd ones included, and are reported visible', () => {
  const r = repo();
  fs.mkdirSync(r.file('.claude/skills')); fs.mkdirSync(r.file('.claude/agents'));
  for (const n of r.skills) fs.symlinkSync(`../../.agents/skills/${n}`, r.file(`.claude/skills/${n}`));
  for (const f of r.agents) fs.symlinkSync(`../../.agents/agents/${f}`, r.file(`.claude/agents/${f}`));
  fs.rmSync(r.file(`.claude/skills/${r.skills[0]}`)); fs.symlinkSync(r.file(`.agents/skills/${r.skills[0]}`), r.file(`.claude/skills/${r.skills[0]}`));
  fs.symlinkSync('../../.agents/skills/retired-skill', r.file('.claude/skills/retired-skill'));
  fs.writeFileSync(r.file('.claude/skills/notes.md'), 'mine\n');
  proveReadOnly(r, allVisible(r));
});

test('.claude/skills -> ../.agents/skills and .claude/agents -> ../.agents/agents are reported visible', () => {
  const r = repo();
  fs.symlinkSync('../.agents/skills', r.file('.claude/skills')); fs.symlinkSync('../.agents/agents', r.file('.claude/agents'));
  proveReadOnly(r, allVisible(r), [r.file('.agents/skills'), r.file('.agents/agents')]);
});

test('.claude/skills linked to a folder outside the repo: that folder is unchanged and the report counts what it holds', () => {
  const r = repo(), elsewhere = tmp('eng-skills-elsewhere-');
  fs.mkdirSync(path.join(elsewhere, r.skills[0])); fs.writeFileSync(path.join(elsewhere, r.skills[0], 'SKILL.md'), 'a skill of my own\n');
  fs.writeFileSync(path.join(elsewhere, 'keep.md'), 'mine\n');
  fs.symlinkSync(elsewhere, r.file('.claude/skills'));
  proveReadOnly(r, [notVisible(r, r.total - 1), new RegExp(`Fix: ${ADD('skills')}; ${LINK_AGENTS}$`)], [elsewhere]);
});

test('loops, dangling links, unreadable entries, FIFOs and folders where a file belongs: a correct count, no crash, no hang', () => {
  const r = repo(), [loop, dangling, unreadable, fifo, fifoDir, dirFile, lockedDir, good] = r.skills, sk = n => r.file(`.claude/skills/${n}`);
  fs.mkdirSync(r.file('.claude/skills'));
  fs.symlinkSync(loop, sk(loop));
  fs.symlinkSync('../../nowhere', sk(dangling));
  fs.mkdirSync(sk(unreadable)); fs.writeFileSync(path.join(sk(unreadable), 'SKILL.md'), 'x\n'); fs.chmodSync(path.join(sk(unreadable), 'SKILL.md'), 0o000);
  fs.mkdirSync(sk(fifo)); execSync(`mkfifo ${JSON.stringify(path.join(sk(fifo), 'SKILL.md'))}`);
  execSync(`mkfifo ${JSON.stringify(sk(fifoDir))}`);
  fs.mkdirSync(path.join(sk(dirFile), 'SKILL.md'), { recursive: true });
  fs.mkdirSync(sk(lockedDir)); fs.writeFileSync(path.join(sk(lockedDir), 'SKILL.md'), 'x\n'); fs.chmodSync(sk(lockedDir), 0o000);
  fs.symlinkSync(`../../.agents/skills/${good}`, sk(good));
  fs.symlinkSync('agents', r.file('.claude/agents'));
  const visible = 1 + (ROOT_USER ? 2 : 0);
  proveReadOnly(r, [notVisible(r, r.total - visible), new RegExp(`Fix: ${ADD('skills')}; ${ADD('agents')}$`)]);
  fs.rmSync(r.file('.claude/agents')); fs.symlinkSync('../missing', r.file('.claude/agents'));
  proveReadOnly(r, notVisible(r, r.total - visible));
});

test('without claude-code in agents.harnesses there is no visibility line', () => {
  const r = repo();
  const c = YAML.parse(fs.readFileSync(r.file('eng.config.yml'), 'utf8')); c.agents.harnesses = ['codex'];
  fs.writeFileSync(r.file('eng.config.yml'), YAML.stringify(c));
  for (const args of [['sync'], ['doctor']]) { const res = r.eng(args); assert.equal(res.status, 0, out(res)); assert.equal(report(res), '', args.join(' ')); }
  assert.ok(!fs.existsSync(r.file('.claude/skills')));
});
