// A gate inside a gate (PR 50, rounds 4 and 5). A check is a leaf: eng lint fails a checks-dir script that runs `eng gate`.
// When one runs anyway and defers a check, its exit 3 can be lost on the way out (`eng gate | cat`, `|| true`), so it also
// signals every enclosing eng gate and eng run -- of the same repository with SIGURG. No file, directory or disk space is
// involved, so nothing can fail to be written and nothing is ever deleted. SIGURG's default action is to ignore it, so a
// process that turns out not to be listening (an older eng) is never killed; a spurious one can only make a run fail.
// The enclosing processes are found by process ancestry, by the check's systemd scope name in /proc/self/cgroup (eng's unit
// names carry the gate's pid) and by the watchdog's inherited unit tag, and each is confirmed before it is signalled: its
// command line is eng gate or eng run --, and its working directory is in the same repository (git common dir).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SIGNAL = 'SIGURG';
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });

// [ppid, start time] of pid, or null when it has gone. Linux: /proc/<pid>/stat; elsewhere ps.
function proc(pid) {
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); return [Number(st[1]), st[19]]; } catch { return null; }
  }
  const m = run('ps', ['-o', 'ppid=,lstart=', '-p', String(pid)]).stdout?.trim().match(/^(\d+)\s+(.+)$/);
  return m ? [Number(m[1]), m[2]] : null;
}
const argvOf = pid => {
  if (process.platform === 'linux') { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return []; } }
  return (run('ps', ['-o', 'command=', '-p', String(pid)]).stdout || '').trim().split(/\s+/);
};
const cwdOf = pid => {
  if (process.platform === 'linux') { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  return (run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout || '').split('\n').find(l => l.startsWith('n'))?.slice(1) || null;
};
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
export const commonDir = cwd => { const r = run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']); return r.status === 0 ? real(r.stdout.trim()) : null; };
// An eng gate, or an eng run -- (the only run that listens), by its command line.
const listens = argv => argv.some((x, i) => /(^|\/)eng(\.mjs)?$/.test(x) && (argv[i + 1] === 'gate' || (argv[i + 1] === 'run' && argv.includes('--') && !argv.includes('--here'))));

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
// could not signal or could not confirm, which the caller reports loudly.
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
    const cwd = cwdOf(pid), theirs = cwd && commonDir(cwd);
    if (!theirs) { failed.push(`${pid} (cannot read its repository)`); continue; }
    if (theirs !== repo || (start && proc(pid)?.[1] !== start)) continue;
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
