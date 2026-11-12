// Which agent tools can see the skills eng renders (Matt, 10 Nov 2026). No harness standard exists for where skills
// live, and many developers link every tool's folder to one central folder, so eng never creates or changes links. It
// reports what each tool sees at its repo-level folders and says how to link them or install into each one.
import fs from 'node:fs';
import path from 'node:path';

// The repo-level folders each tool reads skills from (checked 10 Nov 2026), and the folder whose link would fix it.
// Codex: .agents/skills in each folder from the cwd up to the repo root; follows symlinked skill folders
//   (https://learn.chatgpt.com/docs/build-skills). eng runs at the root, so only the root's folder is checked.
// Cursor: .agents/skills, .cursor/skills, .claude/skills, .codex/skills, and nested .cursor/skills or .agents/skills
//   (https://cursor.com/docs/skills). Nested folders are not checked.
// Claude Code: .claude/skills/<name>/SKILL.md from the start folder up to the repo root, subagents in .claude/agents; it
//   does not read .agents/skills (https://code.claude.com/docs/en/skills).
export const TOOLS = {
  codex: { reads: ['.agents/skills'], fix: '.agents/skills' },
  cursor: { reads: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'], fix: '.agents/skills' },
  'claude-code': { reads: ['.claude/skills'], agents: '.claude/agents', fix: '.claude/skills' },
};
export const FOLDERS = ['.agents', '.claude', '.claude/skills', '.claude/agents'];
export const NOT_CHECKED = 'Not checked: skills in your home folder (~/.agents/skills, ~/.claude/skills, ~/.cursor/skills, ~/.codex/skills) and /etc/codex/skills.';

// Reads only: lstat, stat, access, readlink and realpath. Nothing is opened, so a FIFO cannot block, and any error counts
// as absent or not readable.
export function fsProbe(root) {
  const abs = rel => path.join(root, rel);
  return {
    root,
    entry(rel) {
      let st; try { st = fs.lstatSync(abs(rel)); } catch { return { kind: 'absent' }; }
      if (!st.isSymbolicLink()) return { kind: st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'other' };
      let to = '?'; try { to = fs.readlinkSync(abs(rel)); } catch {}
      let broken = false; try { fs.statSync(abs(rel)); } catch { broken = true; }
      return { kind: 'link', to, broken };
    },
    readable(rel) { try { if (!fs.statSync(abs(rel)).isFile()) return false; fs.accessSync(abs(rel), fs.constants.R_OK); return true; } catch { return false; } },
    real(rel) { try { return fs.realpathSync(abs(rel)); } catch { return null; } },
  };
}

export const q = s => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

// skills: eng's skill names; subagents: its subagent file names; skillsDir: agents.skills_dir. Subagents render into the
// agents/ folder beside it. Returns folder states, what each tool sees, and one fix per folder that needs it.
export function skillVisibility({ skills, subagents, skillsDir, probe }) {
  skills = [...new Set(skills)]; subagents = [...new Set(subagents)];
  const agentsDir = `${path.dirname(skillsDir)}/agents`;
  const folders = FOLDERS.map(p => ({ path: p, ...probe.entry(p) }));
  const seenIn = (dirs, file) => dirs.some(d => probe.readable(`${d}/${file}`));
  const tools = Object.entries(TOOLS).map(([tool, t]) => {
    const missingSkills = skills.filter(n => !seenIn(t.reads, `${n}/SKILL.md`)).length;
    const missingAgents = t.agents ? subagents.filter(f => !probe.readable(`${t.agents}/${f}`)).length : 0;
    const total = skills.length + (t.agents ? subagents.length : 0);
    return { tool, reads: t.agents ? [...t.reads, t.agents] : t.reads, seen: total - missingSkills - missingAgents, total, missingSkills, missingAgents };
  });
  // A link's target is read from the folder it sits in, after symlinks: when .claude is itself a link, ../<src> would
  // point beside the link's target, not into this repo. So the target is relative to the real parent folder.
  const root = probe.real('.') ?? probe.root;
  const target = (d, src) => path.relative(probe.real(path.dirname(d)) ?? path.join(root, path.dirname(d)), path.join(root, src)) || '.';
  const made = new Set();
  // PR #71 review: a link only shows what its source folder holds, and it cannot go inside a parent that is a file or a
  // broken link. So the source is repaired first, and a bad parent is named instead of a command that would fail.
  const fixFor = (d, src) => {
    if (path.resolve('/', d) === path.resolve('/', src)) return gone.length ? { folder: d, src, text: 'run eng sync' } : null;
    if (probe.entry(d).kind !== 'absent') return { folder: d, src, text: `add the missing entries to ${d}, or point ${d} at ${src}` };
    const dir = path.dirname(d), up = probe.entry(dir);
    if (up.kind === 'link' && up.broken || up.kind !== 'absent' && up.kind !== 'folder' && up.kind !== 'link') return { folder: d, src, text: `${dir} is ${up.kind === 'link' ? 'a broken link' : `a ${up.kind}`}, so no link can go inside it: move it aside or repair it, then run eng doctor again` };
    const parent = up.kind === 'absent' && !made.has(dir) ? `mkdir -p ${q(dir)} && ` : '';
    made.add(dir);
    return { folder: d, src, text: `${parent}ln -s ${q(target(d, src))} ${q(d)}` };
  };
  const fixes = [];
  const need = (d, src) => { if (fixes.some(f => f.folder === d)) return; const f = fixFor(d, src); if (f && !fixes.some(x => x.text === f.text)) fixes.push(f); };
  const sources = [...skills.map(n => `${skillsDir}/${n}/SKILL.md`), ...subagents.map(f => `${agentsDir}/${f}`)].filter(p => !probe.readable(p));
  const gone = sources.filter(p => probe.entry(p).kind === 'absent'), locked = sources.filter(p => !gone.includes(p));
  // The exact files, all of them (PR #71 reviews 2 and 3): a shortened list could not run as printed, and chmod -R over the
  // folders also changed outside files hard-linked into them and skipped skills that are symlinks. chmod on a named
  // file follows its symlink and touches nothing else.
  if (locked.length) fixes.push({ folder: null, src: null, text: `make eng's files readable: chmod u+r ${locked.map(q).join(' ')}` });
  if (gone.length) fixes.push({ folder: skillsDir, src: skillsDir, text: 'run eng sync' });
  for (const t of tools) {
    if (t.missingSkills) need(TOOLS[t.tool].fix, skillsDir);
    if (t.missingAgents) need(TOOLS[t.tool].agents, agentsDir);
  }
  return { skillsDir, agentsDir, skills: skills.length, subagents: subagents.length, folders, tools, fixes };
}

const folderText = f => f.kind === 'link' ? `link to ${f.to}${f.broken ? ' (broken)' : ''}` : f.kind;

// The eng doctor section. Informational: a tool not in agents.harnesses that misses skills is marked info, not WARN.
export function visibilityReport(v, harnesses) {
  const subs = v.subagents ? ` and ${v.subagents} subagents into ${v.agentsDir}` : '';
  const rows = v.tools.map(t => {
    const mark = t.seen === t.total ? 'ok  ' : harnesses.includes(t.tool) ? 'WARN' : 'info';
    return `    ${mark} ${t.tool}: ${t.seen} of ${t.total} ${TOOLS[t.tool].agents ? 'skills and subagents' : 'skills'} (reads ${t.reads.join(', ')})`;
  });
  const fix = v.fixes.length ? [`    To show them to every tool: ${v.fixes.map(f => f.text).join('; ')}. Or install eng's skills into each tool's own folder. eng never creates or changes links.`] : [];
  return [`  Skills (eng renders ${v.skills} into ${v.skillsDir}${subs}):`, `    ${v.folders.map(f => `${f.path}: ${folderText(f)}`).join('; ')}`, ...rows, ...fix, `    ${NOT_CHECKED}`].join('\n');
}

// eng sync's one-line Claude Code report (unchanged since 0.17.2).
export function claudeLine(v) {
  const c = v.tools.find(t => t.tool === 'claude-code');
  if (c.seen === c.total) return { ok: true, what: `claude-code: all ${c.total} eng skills and subagents are visible in .claude/skills and .claude/agents` };
  const fix = v.fixes.filter(f => f.folder?.startsWith('.claude/')).map(f => f.text).join('; ');
  return { ok: false, what: `claude-code: ${c.total - c.seen} of ${c.total} eng skills and subagents are not visible in .claude/skills or .claude/agents (eng renders them into ${v.skillsDir} and ${v.agentsDir}, and never writes into .claude/skills or .claude/agents). Fix: ${fix}` };
}
