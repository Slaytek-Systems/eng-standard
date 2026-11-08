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
// The index of eng in argv when eng is the program itself: argv[0] is eng (its shebang), or argv[0] is a JS runtime and eng
// is its entry script (the first argument after the runtime's own options). -1 otherwise: an eng path that is only data to
// another program (a supervisor or test harness handed `eng.mjs gate` as arguments) is not eng (PR 50, round 7).
const ENG = /(^|\/)eng(\.mjs)?$/, RUNTIME = /(^|\/)(node|nodejs|bun)(\d+(\.\d+)*)?$/, TAKES_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C']);
function engAt(argv) {
  if (ENG.test(argv[0] || '')) return 0;
  if (!RUNTIME.test(argv[0] || '')) return -1;
  let j = 1;
  while (j < argv.length && argv[j].startsWith('-') && argv[j] !== '--') j += TAKES_VALUE.has(argv[j]) ? 2 : 1;
  return ENG.test(argv[j] || '') ? j : -1;
}
// An eng gate, or an eng run -- (the only run that listens; eng run --here does not), by its command line. Only eng's own
// options count: what follows -- is the command's.
export const listens = argv => {
  const i = engAt(argv), own = argv.slice(i + 2), dd = own.indexOf('--');
  return i >= 0 && (argv[i + 1] === 'gate' || (argv[i + 1] === 'run' && dd >= 0 && !own.slice(0, dd).includes('--here')));
};

// Called by an enclosing eng gate or eng run at start. open() starts a window (a step, or the run's command); close(w)
// lets a signal that is already pending reach its handler (a signal that came during spawnSync runs it only after the
// next turn of the event loop), then ends the window and says whether a signal came during it. stray() says whether one
// came while no window was open.
export function enclose() {
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
