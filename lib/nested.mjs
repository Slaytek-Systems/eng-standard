// A gate inside a gate (PR 50, rounds 4 and 5). A check is a leaf: eng lint fails a checks-dir script that runs `eng gate`.
// When one runs anyway and defers a check, its exit 3 can be lost on the way out (`eng gate | cat`, `|| true`), so it also
// signals every enclosing eng gate and eng run -- of the same repository with SIGURG. No file, directory or disk space is
// involved, so nothing can fail to be written and nothing is ever deleted. SIGURG's default action is to ignore it, so a
// process that turns out not to be listening (an older eng) is never killed; a spurious one can only make a run fail.
// The enclosing processes are found by process ancestry, by the check's systemd scope name in /proc/self/cgroup (eng's unit
// names carry the gate's pid) and by the watchdog's inherited unit tag, and each is confirmed before it is signalled: its
// command line is eng gate or eng run --, and its working directory is in the same repository (git common dir, read from the
// filesystem, so a check whose PATH has no git still finds it). When eng cannot tell, it signals anyway: a spurious signal
// only makes a run fail, a missed one lets it pass.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SIGNAL = 'SIGURG';
// Absolute paths (macOS): the gate's PATH is the check's, which may not have them.
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

// [ppid, start time] of pid, or null when it has gone. Linux: /proc/<pid>/stat; elsewhere ps.
function proc(pid) {
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); return [Number(st[1]), st[19]]; } catch { return null; }
  }
  const m = run('/bin/ps', ['-o', 'ppid=,lstart=', '-p', String(pid)]).stdout?.trim().match(/^(\d+)\s+(.+)$/);
  return m ? [Number(m[1]), m[2]] : null;
}
const argvOf = pid => {
  if (process.platform === 'linux') { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return []; } }
  return (run('/bin/ps', ['-o', 'command=', '-p', String(pid)]).stdout || '').trim().split(/\s+/);
};
const cwdOf = pid => {
  if (process.platform === 'linux') { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  return (run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout || '').split('\n').find(l => l.startsWith('n'))?.slice(1) || null;
};
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
// The git common dir of the repository holding cwd, from the nearest .git (a directory, or a worktree's `gitdir:` file) and
// its commondir file; null when there is none. No git process: it would run from the caller's PATH.
export function commonDir(cwd) {
  for (let d = real(cwd); d; d = d === path.dirname(d) ? null : path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    let gitDir;
    try { gitDir = fs.statSync(dotGit).isDirectory() ? dotGit : path.resolve(d, fs.readFileSync(dotGit, 'utf8').match(/^gitdir: (.+)$/m)[1].trim()); } catch (e) { if (e.code === 'ENOENT') continue; return null; }
    let common = '.'; try { common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); } catch {}
    return real(path.resolve(gitDir, common));
  }
  return null;
}
// A listening eng names itself: enclose() sets process.title to `eng-listening gate` or `eng-listening run`, which on Linux
// replaces the whole of /proc/<pid>/cmdline. eng never guesses from argv: an eng path or `gate` passed as data to another
// program (a supervisor, `node --eval`, `node -`, an option value) can never make it a recipient (PR 50, rounds 7-9). Only a
// process that renamed itself on purpose (`exec -a`) can look like one, and that is a deliberate act. Where the title is not
// visible in the process table (macOS `ps` may not show it), nothing is signalled: the notice is best effort, a signal to an
// unrelated program is harm.
const TITLE = /^eng-listening (gate|run)$/;
export const listens = argv => TITLE.test(argv.filter(Boolean).join(' '));

// Called by an enclosing eng gate or eng run at start. open() starts a window (a step, or the run's command); close(w)
// lets a signal that is already pending reach its handler (a signal that came during spawnSync runs it only after the
// next turn of the event loop), then ends the window and says whether a signal came during it. stray() says whether one
// came while no window was open.
export function enclose(kind = 'gate') {
  process.title = `eng-listening ${kind}`;
  const open = new Set(); let stray = false;
  process.on(SIGNAL, () => { if (!open.size) stray = true; for (const w of open) w.hit = true; });
  const turn = () => new Promise(r => setImmediate(r));
  return {
    open: () => { const w = { hit: false }; open.add(w); return w; },
    close: async w => { await turn(); await turn(); open.delete(w); return w.hit; },
    stray: () => stray,
  };
}

// Called by a gate that ends incomplete. Returns { told, failed }: the pids it signalled, and the enclosing ones it found but
// could not signal, which the caller reports loudly.
export function tellEnclosing(repo) {
  const found = new Map(), told = [], failed = [];
  for (let p = proc(process.pid); p && p[0] > 1;) { const pid = p[0]; p = proc(pid); if (p) found.set(pid, p[1]); }
  let cg = ''; try { cg = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch {}
  // The scope name (systemd path), and the watchdog's inherited unit tag for a gate that left the process tree.
  for (const u of [cg.match(/\/(eng-[a-z0-9-]+)\.scope$/m)?.[1], process.env.ENG_BUDGET_UNIT]) {
    const pid = Number(u?.match(/^eng-[a-z0-9-]*-(\d+)-\d+-[a-z0-9]+$/)?.[1]);
    if (pid > 1 && !found.has(pid)) found.set(pid, null);
  }
  for (const [pid, start] of found) {
    if (pid === process.pid || !listens(argvOf(pid))) continue;
    // Another repository's (a fixture's) is left alone; one eng cannot place (no cwd, no repository found) is signalled.
    const cwd = cwdOf(pid), theirs = cwd && commonDir(cwd);
    if ((repo && theirs && theirs !== repo) || (start && proc(pid)?.[1] !== start)) continue;
    try { process.kill(pid, SIGNAL); told.push(pid); } catch (e) { failed.push(`${pid} (${e.code})`); }
  }
  return { told, failed };
}

// eng lint: a checks-dir script that runs eng gate (eng, eng.mjs, npx eng, or a variable named for eng). Comment lines and
// quoted text are skipped. A line that means it carries `# nested gate: <why>`, a visible trace for the reviewer.
export const NESTED_GATE_RULE = {
  id: 'check-runs-gate',
  pattern: '^(?!\\s*#)(?!.*#\\s*nested gate: \\S).*((^|[\\s;&|(`/])(eng|eng\\.mjs)|\\$\\{?\\w*(eng|ENG)\\w*\\}?"?)\\s+gate(\\s|$|[;&|)])',
  flags: '',
  message: 'A check is a leaf: it never runs eng gate; the gate composes the checks. Put what this check runs in the check itself, or make it its own check. A gate inside a check that defers anything makes the enclosing gate incomplete (exit 3) anyway. If the nested gate is the subject under test (a fixture repo), end the line with # nested gate: <why>.',
};
