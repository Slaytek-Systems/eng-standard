// eng doctor reports which agent tools can see eng's skills and never creates or changes a link (Matt, 10 Nov 2026).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { skillVisibility, fsProbe, visibilityReport } from '../lib/skill-visibility.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const ROOT_USER = process.getuid?.() === 0;
const scratch = [];
after(() => scratch.forEach(d => { try { execSync(`chmod -R u+rwx ${JSON.stringify(d)}`); } catch {} fs.rmSync(d, { recursive: true, force: true }); }));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); scratch.push(d); return d; };

const SKILLS = ['alpha', 'beta', 'gamma'], AGENTS = ['helper.md'];
// A repo with eng's skills rendered into <skillsDir> and subagents into the agents/ folder beside it.
function fixture(skillsDir = '.agents/skills') {
  const dir = tmp('eng-vis-'), f = p => path.join(dir, p);
  for (const n of SKILLS) { fs.mkdirSync(f(`${skillsDir}/${n}`), { recursive: true }); fs.writeFileSync(f(`${skillsDir}/${n}/SKILL.md`), `# ${n}\n`); }
  fs.mkdirSync(f(`${path.dirname(skillsDir)}/agents`), { recursive: true }); fs.writeFileSync(f(`${path.dirname(skillsDir)}/agents/helper.md`), 'x\n');
  const v = () => skillVisibility({ skills: SKILLS, subagents: AGENTS, skillsDir, probe: fsProbe(dir) });
  const seen = () => Object.fromEntries(v().tools.map(t => [t.tool, `${t.seen}/${t.total}`]));
  const states = () => Object.fromEntries(v().folders.map(x => [x.path, x.kind === 'link' ? `link ${x.to}${x.broken ? ' broken' : ''}` : x.kind]));
  const fixes = () => v().fixes.map(x => x.text);
  return { dir, f, v, seen, states, fixes };
}

test('nothing linked: codex and cursor see every skill, claude-code sees none, and the fix links both .claude folders', () => {
  const r = fixture();
  assert.deepEqual(r.states(), { '.agents': 'folder', '.claude': 'absent', '.claude/skills': 'absent', '.claude/agents': 'absent' });
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '0/4' });
  assert.deepEqual(r.fixes(), ['mkdir -p .claude && ln -s ../.agents/skills .claude/skills', 'ln -s ../.agents/agents .claude/agents']);
});

test('.claude/skills and .claude/agents linked to .agents: every tool sees everything and no fix is printed', () => {
  const r = fixture(); fs.mkdirSync(r.f('.claude'));
  fs.symlinkSync('../.agents/skills', r.f('.claude/skills')); fs.symlinkSync('../.agents/agents', r.f('.claude/agents'));
  assert.deepEqual(r.states(), { '.agents': 'folder', '.claude': 'folder', '.claude/skills': 'link ../.agents/skills', '.claude/agents': 'link ../.agents/agents' });
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '4/4' });
  assert.deepEqual(r.fixes(), []);
});

test('.claude itself a link: the fix is relative to the real .claude folder, and running it makes claude-code see all', () => {
  const r = fixture(); fs.mkdirSync(r.f('config/nested/claude'), { recursive: true }); fs.symlinkSync('config/nested/claude', r.f('.claude'));
  assert.equal(r.states()['.claude'], 'link config/nested/claude');
  assert.deepEqual(r.fixes(), ['ln -s ../../../.agents/skills .claude/skills', 'ln -s ../../../.agents/agents .claude/agents']);
  for (const cmd of r.fixes()) execSync(cmd, { cwd: r.dir, shell: '/bin/sh' });
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '4/4' });
});

test('a custom skills_dir: codex and cursor see none until .agents/skills is linked to it; the quoted fix works', () => {
  const r = fixture("my skills/it's");
  assert.deepEqual(r.seen(), { codex: '0/3', cursor: '0/3', 'claude-code': '0/4' });
  assert.deepEqual(r.fixes(), [`mkdir -p .agents && ln -s '../my skills/it'\\''s' .agents/skills`, `mkdir -p .claude && ln -s '../my skills/it'\\''s' .claude/skills`, `ln -s '../my skills/agents' .claude/agents`]);
  for (const cmd of r.fixes()) execSync(cmd, { cwd: r.dir, shell: '/bin/sh' });
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '4/4' });
});

test('cursor sees a skill in any of its folders; codex only in .agents/skills', () => {
  const r = fixture('skills');
  fs.mkdirSync(r.f('.cursor/skills/alpha'), { recursive: true }); fs.writeFileSync(r.f('.cursor/skills/alpha/SKILL.md'), 'x\n');
  fs.mkdirSync(r.f('.codex/skills/beta'), { recursive: true }); fs.writeFileSync(r.f('.codex/skills/beta/SKILL.md'), 'x\n');
  assert.deepEqual(r.seen(), { codex: '0/3', cursor: '2/3', 'claude-code': '0/4' });
});

test('a partial .claude/skills: claude-code counts what is there and the fix says add or point, not ln', () => {
  const r = fixture(); fs.mkdirSync(r.f('.claude/skills'), { recursive: true });
  fs.symlinkSync('../../.agents/skills/alpha', r.f('.claude/skills/alpha'));
  fs.mkdirSync(r.f('.claude/skills/beta')); fs.writeFileSync(r.f('.claude/skills/beta/SKILL.md'), 'mine\n');
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '2/4' });
  assert.deepEqual(r.fixes(), ['add the missing entries to .claude/skills, or point .claude/skills at .agents/skills', 'ln -s ../.agents/agents .claude/agents']);
});

test('a broken link is reported as broken and sees nothing', () => {
  const r = fixture(); fs.mkdirSync(r.f('.claude')); fs.symlinkSync('../nowhere', r.f('.claude/skills'));
  assert.equal(r.states()['.claude/skills'], 'link ../nowhere broken');
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '0/4' });
  assert.equal(r.fixes()[0], 'add the missing entries to .claude/skills, or point .claude/skills at .agents/skills');
});

test('an unreadable SKILL.md is not visible, and the first fix makes it readable (eng sync would fail on it)', { skip: ROOT_USER && 'root reads every file' }, () => {
  const r = fixture(); fs.chmodSync(r.f('.agents/skills/alpha/SKILL.md'), 0o000);
  assert.deepEqual(r.seen(), { codex: '2/3', cursor: '2/3', 'claude-code': '0/4' });
  assert.equal(r.fixes()[0], "make eng's files readable: chmod -R u+rX .agents/skills");
});

// PR #71 review 2: with many unreadable files the printed command must still run as printed and fix them all.
test('many unreadable files: the readable fix is one runnable command, and running every printed fix makes all visible', { skip: ROOT_USER && 'root reads every file' }, () => {
  const r = fixture();
  for (const n of SKILLS) fs.chmodSync(r.f(`.agents/skills/${n}/SKILL.md`), 0o000);
  fs.chmodSync(r.f('.agents/agents/helper.md'), 0o000);
  assert.deepEqual(r.fixes()[0], "make eng's files readable: chmod -R u+rX .agents/skills .agents/agents");
  for (const cmd of r.fixes()) assert.equal(spawnSync('sh', ['-c', cmd.replace(/^make eng's files readable: /, '')], { cwd: r.dir }).status, 0, cmd);
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '4/4' });
});

// PR #71 review: with a custom skills_dir and one rendered skill gone, the links alone left every tool one short. The
// source is repaired first (eng sync), and following the whole printed fix makes every tool see everything.
test('a skill missing from a custom skills_dir: eng sync comes first, and the whole fix makes every tool see all', () => {
  const r = fixture('tools/skills');
  fs.rmSync(r.f('tools/skills/beta'), { recursive: true });
  const fixes = r.fixes();
  assert.equal(fixes[0], 'run eng sync');
  for (const n of ['beta']) { fs.mkdirSync(r.f(`tools/skills/${n}`), { recursive: true }); fs.writeFileSync(r.f(`tools/skills/${n}/SKILL.md`), `# ${n}\n`); }
  for (const cmd of fixes.slice(1)) assert.equal(spawnSync('sh', ['-c', cmd], { cwd: r.dir }).status, 0, cmd);
  assert.deepEqual(r.seen(), { codex: '3/3', cursor: '3/3', 'claude-code': '4/4' });
  assert.deepEqual(r.fixes(), []);
});

test('a .claude or .agents that is a file or a broken link is named, never given a link command that would fail', () => {
  const r = fixture(); fs.writeFileSync(r.f('.claude'), 'not a folder\n');
  assert.deepEqual(r.fixes(), ['.claude is a file, so no link can go inside it: move it aside or repair it, then run eng doctor again']);
  const b = fixture(); fs.symlinkSync('missing-target', b.f('.claude'));
  assert.match(b.fixes()[0], /^\.claude is a broken link, so no link can go inside it/);
  const c = fixture('tools/skills'); fs.writeFileSync(c.f('.agents'), 'not a folder\n');
  assert.ok(c.fixes().includes('.agents is a file, so no link can go inside it: move it aside or repair it, then run eng doctor again'), c.fixes().join(' | '));
});

test('the report marks a tool outside agents.harnesses info, not WARN, and always says what is not checked', () => {
  const text = visibilityReport(fixture().v(), ['codex']);
  assert.match(text, /^ {4}ok {3}codex: 3 of 3 skills \(reads \.agents\/skills\)$/m);
  assert.match(text, /^ {4}info claude-code: 0 of 4 skills and subagents \(reads \.claude\/skills, \.claude\/agents\)$/m);
  assert.match(text, /eng never creates or changes links/);
  assert.match(text, /Not checked: skills in your home folder/);
  assert.match(visibilityReport(fixture().v(), ['claude-code']), /^ {4}WARN claude-code/m);
});

// Every entry under .claude and .agents, read with lstat only: kind, mode, inode, mtime and a link's target.
function shot(dir) {
  const s = {};
  const walk = rel => {
    let st; try { st = fs.lstatSync(path.join(dir, rel)); } catch (e) { s[rel] = e.code; return; }
    s[rel] = { link: st.isSymbolicLink() && fs.readlinkSync(path.join(dir, rel)), mode: st.mode, ino: st.ino, mtime: st.mtimeMs, size: st.size };
    if (st.isDirectory()) for (const n of fs.readdirSync(path.join(dir, rel)).sort()) walk(`${rel}/${n}`);
  };
  walk('.claude'); walk('.agents');
  return s;
}

test('eng doctor on an eng init repo: the section, the same exit code with and without the link, and no writes', () => {
  const dir = tmp('eng-vis-doctor-');
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
  c.gates.required = []; c.agents.rules = []; c.constraints = { rules: [] };
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  const eng = args => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ENG_STANDARD_SOURCE: PKG } });
  const init = eng(['init']); assert.equal(init.status, 0, init.stdout + init.stderr);
  const n = fs.readdirSync(path.join(dir, '.agents/skills')).length, a = fs.readdirSync(path.join(dir, '.agents/agents')).length;
  const doctor = () => { const before = shot(dir), res = eng(['doctor']); assert.deepEqual(shot(dir), before, 'doctor created or changed nothing under .claude or .agents'); return res; };

  const plain = doctor();
  assert.match(plain.stdout, new RegExp(`^ {2}Skills \\(eng renders ${n} into \\.agents/skills and ${a} subagents into \\.agents/agents\\):$`, 'm'));
  assert.match(plain.stdout, /^ {4}\.agents: folder; \.claude: folder; \.claude\/skills: absent; \.claude\/agents: absent$/m);
  assert.match(plain.stdout, new RegExp(`^ {4}ok {3}codex: ${n} of ${n} skills`, 'm'));
  assert.match(plain.stdout, new RegExp(`^ {4}ok {3}cursor: ${n} of ${n} skills`, 'm'));
  assert.match(plain.stdout, new RegExp(`^ {4}WARN claude-code: 0 of ${n + a} skills and subagents`, 'm'));
  assert.match(plain.stdout, /To show them to every tool: ln -s \.\.\/\.agents\/skills \.claude\/skills; ln -s \.\.\/\.agents\/agents \.claude\/agents\./);

  execSync('ln -s ../.agents/skills .claude/skills', { cwd: dir });
  const linked = doctor();
  assert.equal(linked.status, plain.status, 'doctor exits the same with and without the link');
  assert.match(linked.stdout, /\.claude\/skills: link to \.\.\/\.agents\/skills;/);
  assert.match(linked.stdout, new RegExp(`^ {4}WARN claude-code: ${n} of ${n + a} skills and subagents`, 'm'));
  assert.match(linked.stdout, /To show them to every tool: ln -s \.\.\/\.agents\/agents \.claude\/agents\./);
});
