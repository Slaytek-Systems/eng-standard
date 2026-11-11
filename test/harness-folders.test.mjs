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
// eng doctor prints a Skills section (lib/skill-visibility.mjs) instead of sync's line: its claude-code row counts what is
// visible, and its fix names the same commands.
const syncClaude = line => { const m = line.match(/claude-code: (?:all (\d+)|(\d+) of (\d+)) .*?(?:Fix: (.*))?$/); return m[1] ? { seen: +m[1], total: +m[1], fix: [] } : { seen: m[3] - m[2], total: +m[3], fix: m[4].split('; ') }; };
const doctorClaude = res => {
  const row = out(res).match(/^ {4}(?:ok {2}|WARN) claude-code: (\d+) of (\d+) skills and subagents/m), fix = out(res).match(/^ {4}To show them to every tool: (.*)\. Or install/m);
  return { seen: +row[1], total: +row[2], fix: fix ? fix[1].split('; ').filter(f => f.includes('.claude/')) : [] };
};
const LINK_SKILLS = 'ln -s ../.agents/skills .claude/skills', LINK_AGENTS = 'ln -s ../.agents/agents .claude/agents';
const ADD = d => `add the missing entries to .claude/${d}, or point .claude/${d} at .agents/${d}`;

// sync, sync --check, doctor and init: each exits 0 within its timeout, prints the expected report (sync and doctor),
// and leaves .claude/skills, .claude/agents and every extra folder byte for byte, inode and mtime as they were.
function proveReadOnly(r, expect, extra = []) {
  const before = claudeFolders(r), elsewhere = extra.map(snapshot);
  let synced;
  for (const args of [['sync'], ['sync', '--check'], ['doctor'], ['init']]) {
    const res = r.eng(args);
    assert.equal(res.signal, null, `eng ${args.join(' ')} did not hang: ${out(res).slice(-2000)}`);
    assert.equal(res.status, 0, `eng ${args.join(' ')} exits 0: ${out(res).slice(-3000)}`);
    if (args[0] === 'sync' && args.length === 1) { for (const re of [].concat(expect)) assert.match(report(res), re, `eng sync: ${report(res) || out(res).slice(-2000)}`); synced = report(res); }
    if (args[0] === 'doctor') assert.deepEqual(doctorClaude(res), syncClaude(synced), `eng doctor's claude-code row and fix agree with eng sync: ${out(res).slice(-2000)}`);
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

const REFUSED = /\(.*\) is in \.claude\/(skills|agents), which eng never writes into/;
const setSkillsDir = (r, dir) => { const c = YAML.parse(fs.readFileSync(r.file('eng.config.yml'), 'utf8')); c.agents.skills_dir = dir; fs.writeFileSync(r.file('eng.config.yml'), YAML.stringify(c)); };

test('agents.skills_dir inside .claude/skills or .claude/agents is a config error: nothing there is written, read or pruned', () => {
  for (const dir of ['.claude/skills', './.claude/skills/', '/.claude/skills', '.Claude/Skills', '.claude/skills/eng', '.claude/agents/x', '.claude/custom']) {
    const r = repo();
    fs.mkdirSync(r.file('.claude/skills/how'), { recursive: true }); fs.writeFileSync(r.file('.claude/skills/how/SKILL.md'), 'mine\n');
    fs.mkdirSync(r.file('.claude/agents')); fs.writeFileSync(r.file('.claude/agents/poteto-agent.md'), 'mine\n');
    execSync(`mkfifo ${JSON.stringify(r.file('.claude/skills/how/fifo'))}`);
    setSkillsDir(r, dir);
    const before = claudeFolders(r);
    for (const args of [['sync'], ['sync', '--check'], ['init']]) {
      const res = r.eng(args);
      assert.equal(res.signal, null, `${dir}: eng ${args.join(' ')} did not hang`);
      assert.equal(res.status, 1, `${dir}: eng ${args.join(' ')} refuses: ${out(res).slice(-2000)}`);
      assert.match(out(res), REFUSED, `${dir}: ${out(res).slice(-2000)}`);
      assert.deepEqual(claudeFolders(r), before, `${dir}: eng ${args.join(' ')} left .claude/skills and .claude/agents untouched`);
    }
    const doc = r.eng(['doctor']);
    assert.equal(doc.signal, null); assert.notEqual(doc.status, 0, `${dir}: doctor fails on it`);
    assert.match(out(doc), REFUSED, `${dir}: ${out(doc).slice(-2000)}`);
    assert.deepEqual(claudeFolders(r), before, `${dir}: doctor left them untouched`);
  }
});

test('.claude/foo/skills is allowed: its subagent folder .claude/foo/agents is not a harness folder', () => {
  const r = repo(); setSkillsDir(r, '.claude/foo/skills');
  const res = r.eng(['sync']); assert.equal(res.status, 0, out(res));
  assert.ok(fs.existsSync(r.file(`.claude/foo/skills/${r.skills[0]}/SKILL.md`)));
  assert.ok(!fs.existsSync(r.file('.claude/skills')) && !fs.existsSync(r.file('.claude/agents')));
});

test('files an older config rendered into .claude/skills or .claude/agents are never pruned', () => {
  const r = repo();
  const lock = JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8'));
  lock.files.push('.claude/skills/how/SKILL.md', '.claude/agents/poteto-agent.md');
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify(lock, null, 2) + '\n');
  fs.mkdirSync(r.file('.claude/skills/how'), { recursive: true }); fs.writeFileSync(r.file('.claude/skills/how/SKILL.md'), 'old render\n');
  fs.mkdirSync(r.file('.claude/agents')); fs.writeFileSync(r.file('.claude/agents/poteto-agent.md'), 'old render\n');
  const before = claudeFolders(r);
  const res = r.eng(['sync']); assert.equal(res.status, 0, out(res));
  assert.doesNotMatch(out(res), /removed \.claude/);
  assert.deepEqual(claudeFolders(r), before);
  assert.ok(!JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8')).files.some(f => f.startsWith('.claude/skills') || f.startsWith('.claude/agents')), 'the new lock lists them no longer');
});

test('a skill selected twice counts once in the report', () => {
  const r = repo();
  const c = YAML.parse(fs.readFileSync(r.file('eng.config.yml'), 'utf8'));
  const wild = c.agents.skills.find(s => s.endsWith('/*')), pack = wild.split('/')[0];
  const one = fs.readdirSync(path.join(PKG, 'vendor', pack, 'skills')).find(n => fs.existsSync(path.join(PKG, 'vendor', pack, 'skills', n, 'SKILL.md')));
  c.agents.skills.push(`${pack}/${one}`, wild);
  fs.writeFileSync(r.file('eng.config.yml'), YAML.stringify(c));
  const res = r.eng(['sync']); assert.equal(res.status, 0, out(res)); assert.match(report(res), notVisible(r, r.total));
  const doc = r.eng(['doctor']); assert.equal(doc.status, 0, out(doc)); assert.deepEqual(doctorClaude(doc), syncClaude(report(res)));
});

// The printed fix, run as printed from the repo root, makes every skill and subagent visible.
function applyFix(r) {
  const fix = report(r.eng(['sync'])).split('Fix: ')[1];
  assert.ok(fix, 'a fix is printed');
  for (const cmd of fix.split('; ')) execSync(cmd, { cwd: r.dir, shell: '/bin/sh', stdio: 'pipe' });
  assert.match(report(r.eng(['sync'])), allVisible(r), fix);
  return fix;
}

test('the printed link fix works when .claude is a symlink, inside or outside the repo', () => {
  const inside = repo();
  fs.mkdirSync(inside.file('config/nested'), { recursive: true });
  fs.renameSync(inside.file('.claude'), inside.file('config/nested/claude')); fs.symlinkSync('config/nested/claude', inside.file('.claude'));
  assert.match(applyFix(inside), /^ln -s \.\.\/\.\.\/\.\.\/\.agents\/skills \.claude\/skills; /);
  const outside = repo(), away = tmp('eng-harness-parent-');
  fs.renameSync(outside.file('.claude'), path.join(away, 'claude')); fs.symlinkSync(path.join(away, 'claude'), outside.file('.claude'));
  applyFix(outside);
});

test('the printed link fix quotes a source path with spaces', () => {
  const r = repo(); setSkillsDir(r, "my skills/it's/skills");
  const res = r.eng(['sync']); assert.equal(res.status, 0, out(res));
  assert.match(applyFix(r), /^ln -s '\.\.\/my skills\/it'\\''s\/skills' \.claude\/skills; /);
});

const editConfig = (r, edit) => { const c = YAML.parse(fs.readFileSync(r.file('eng.config.yml'), 'utf8')); edit(c); fs.writeFileSync(r.file('eng.config.yml'), YAML.stringify(c)); };
// Every file under the repo except .git, read with lstat: what a refused command must leave as it was.
const repoShot = r => { const s = snapshot(r.dir); for (const k of Object.keys(s)) if (k === './.git' || k.startsWith('./.git/')) delete s[k]; return s; };
const seedHarness = r => {
  fs.mkdirSync(r.file('.claude/skills/how'), { recursive: true }); fs.writeFileSync(r.file('.claude/skills/how/SKILL.md'), 'mine\n');
  fs.writeFileSync(r.file('.claude/skills/.gitkeep'), 'mine\n');
  fs.mkdirSync(r.file('.claude/agents/x'), { recursive: true }); fs.writeFileSync(r.file('.claude/agents/poteto-agent.md'), 'mine\n');
  execSync(`mkfifo ${JSON.stringify(r.file('.claude/agents/x/.gitkeep'))}`);
};
// sync, sync --check, init and doctor refuse it, within the timeout, and nothing in the repo changes.
function proveRefused(r, why) {
  const before = repoShot(r);
  for (const args of [['sync'], ['sync', '--check'], ['init'], ['doctor']]) {
    const res = r.eng(args);
    assert.equal(res.signal, null, `${why}: eng ${args.join(' ')} did not hang`);
    assert.equal(res.status, 1, `${why}: eng ${args.join(' ')} refuses: ${out(res).slice(-2000)}`);
    assert.match(out(res), REFUSED, `${why}: ${out(res).slice(-2000)}`);
    assert.deepEqual(repoShot(r), before, `${why}: eng ${args.join(' ')} changed nothing in the repo`);
  }
}

test('verification.checks_dir inside .claude/skills or .claude/agents is refused too, before anything is read or written', () => {
  for (const dir of ['.claude/skills', '.claude/agents/x', './.Claude/Skills/']) {
    const r = repo(); seedHarness(r); editConfig(r, c => { c.verification = { ...c.verification, checks_dir: dir }; });
    proveRefused(r, `checks_dir ${dir}`);
  }
});

test('a path that leaves the repo and comes back in (../<repo>/.claude/skills) is refused like the plain one', () => {
  for (const dir of ['skills', 'custom']) {
    const r = repo(); seedHarness(r); setSkillsDir(r, `../${path.basename(r.dir)}/.claude/${dir}`);
    proveRefused(r, `skills_dir ../<repo>/.claude/${dir}`);
  }
});

test('an old lock entry that names .claude/skills through ../<repo> is never pruned', () => {
  const r = repo(), back = `../${path.basename(r.dir)}`;
  const lock = JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8'));
  lock.files.push(`${back}/.claude/skills/developer.md`, `${back}/.claude/agents/developer.md`);
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify(lock, null, 2) + '\n');
  fs.mkdirSync(r.file('.claude/skills'), { recursive: true }); fs.writeFileSync(r.file('.claude/skills/developer.md'), 'mine\n');
  fs.mkdirSync(r.file('.claude/agents'), { recursive: true }); fs.writeFileSync(r.file('.claude/agents/developer.md'), 'mine\n');
  const before = claudeFolders(r);
  const res = r.eng(['sync']); assert.equal(res.status, 0, out(res));
  assert.deepEqual(claudeFolders(r), before);
});

test('agents.skills_dir .claude: sync keeps empty and unreadable folders in .claude/skills, and the printed fix works', () => {
  const r = repo(); setSkillsDir(r, '.claude');
  fs.mkdirSync(r.file('.claude/skills/empty'), { recursive: true }); fs.mkdirSync(r.file('.claude/agents'));
  const first = r.eng(['sync']); assert.equal(first.status, 0, out(first));
  assert.ok(fs.existsSync(r.file('.claude/skills/empty')) && fs.existsSync(r.file('.claude/agents')), 'empty harness folders stay');
  fs.rmSync(r.file('.claude/skills'), { recursive: true }); fs.rmdirSync(r.file('.claude/agents'));
  assert.match(applyFix(r), /^ln -s \. \.claude\/skills; /);
  const locked = repo(); setSkillsDir(locked, '.claude'); fs.mkdirSync(locked.file('.claude/skills/x'), { recursive: true }); fs.chmodSync(locked.file('.claude/skills'), 0o000);
  for (const args of [['sync'], ['init']]) { const res = locked.eng(args); assert.equal(res.status, 0, `${args}: ${out(res).slice(-2000)}`); }
  fs.chmodSync(locked.file('.claude/skills'), 0o755);
  assert.ok(fs.existsSync(locked.file('.claude/skills/x')));
});

test('a refused config is not migrated: eng.config.yml keeps its bytes', () => {
  const r = repo(); editConfig(r, c => { c.agents.skills_dir = '.claude/skills'; delete c.git?.rewrite_pushed; });
  const before = fs.readFileSync(r.file('eng.config.yml'), 'utf8');
  const res = r.eng(['sync']); assert.equal(res.status, 1, out(res)); assert.match(out(res), REFUSED);
  assert.equal(fs.readFileSync(r.file('eng.config.yml'), 'utf8'), before);
});

// v0.17.2 dropped these folders from every scan; 0.18.1 scans them again (eng only never writes there). An unreadable
// file, a FIFO or a link to one there is tolerated: doctor, lint and gate do not crash or hang, and exit as without them.
test("doctor, lint and gate tolerate unreadable files and FIFOs in .claude/skills and .claude/agents", () => {
  const r = repo(), away = tmp('eng-fifos-');
  editConfig(r, c => { c.gates.required = ['lint']; });
  const run = args => spawnSync(process.execPath, [ENG, ...args], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ENG_STANDARD_SOURCE: PKG } });
  const cmds = [['doctor'], ['lint'], ['gate', 'lint']], without = cmds.map(args => run(args).status);
  for (const d of ['skills', 'agents']) {
    const dev = r.file(`.claude/${d}/developer`); fs.mkdirSync(dev, { recursive: true });
    for (const f of ['health.test.mjs', 'package.json', 'health.test.txt']) { fs.writeFileSync(path.join(dev, f), 'x\n'); fs.chmodSync(path.join(dev, f), 0o000); }
    execSync(`mkfifo ${JSON.stringify(path.join(dev, 'pipe.test.mjs'))}`);
    for (const f of ['fifo.test.mjs', 'fifo.sh']) { const fifo = path.join(away, `${d}-${f}`); execSync(`mkfifo ${JSON.stringify(fifo)}`); fs.symlinkSync(fifo, path.join(dev, f)); }
  }
  const before = claudeFolders(r);
  cmds.forEach((args, i) => {
    const res = run(args);
    assert.equal(res.signal, null, `eng ${args} did not block: ${out(res).slice(-1500)}`);
    assert.equal(res.status, without[i], `eng ${args} exits as it does without them: ${out(res).slice(-2000)}`);
    assert.doesNotMatch(out(res), /EACCES/);
  });
  assert.deepEqual(without, [0, 0, 0]);
  assert.deepEqual(claudeFolders(r), before);
});

// lint checks credential-looking names where eng init baselined them; an empty baseline stands for a repo that adopted.
const secretBaseline = r => { fs.mkdirSync(r.file('renovation/baselines'), { recursive: true }); fs.writeFileSync(r.file('renovation/baselines/secret-filename.json'), JSON.stringify({ kind: 'secret-filename', entries: [] })); };
test('a tracked id_rsa in .claude/skills or .Claude/Skills is caught by the secret-filename check', () => {
  for (const d of ['.claude/skills', '.Claude/Skills']) {
    const r = repo(); secretBaseline(r);
    fs.mkdirSync(r.file(`${d}/x`), { recursive: true }); fs.writeFileSync(r.file(`${d}/x/id_rsa`), 'not a key\n');
    execSync('git add -A', { cwd: r.dir });
    const res = r.eng(['lint']);
    assert.equal(res.status, 1, `${d}: ${out(res).slice(-2000)}`);
    assert.match(out(res), new RegExp(`${d.replace('.', '\\.')}/x/id_rsa:0: \\[secret-filename\\]`), d);
  }
});

test('a lint rule hit inside .claude/agents is reported', () => {
  const r = repo();
  editConfig(r, c => { c.constraints.rules = [{ id: 'no-todo', paths: '**/*.md', pattern: 'TODO-NEVER', message: 'no TODO-NEVER', proven_by: { incident: 'test', fixture: 'none' } }]; });
  fs.mkdirSync(r.file('.claude/agents'), { recursive: true }); fs.writeFileSync(r.file('.claude/agents/helper.md'), 'line\nTODO-NEVER\n');
  execSync('git add -A', { cwd: r.dir });
  const res = r.eng(['lint']);
  assert.equal(res.status, 1, out(res).slice(-2000));
  assert.match(out(res), /\.claude\/agents\/helper\.md:2: \[no-todo\]/);
});
