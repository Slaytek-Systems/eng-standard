// A gate inside a gate (PR 50, round 4). A check is a leaf: eng lint fails a checks-dir script that runs `eng gate`. When
// one runs anyway and defers a check, its exit 3 can be lost on the way out (`eng gate | cat`, `|| true`), so it also
// tells every enclosing eng gate and eng run of the same repository, out of band: a marker file in a per-user directory
// derived from the uid (not the environment), addressed to the enclosing process by pid and start time. The enclosing
// process is found by process ancestry, and on the systemd path also by the check's scope name in /proc/self/cgroup
// (eng's unit names carry the gate's pid), and on the watchdog path by the unit tag the check's environment carries. The enclosing process reads its markers after each step and counts a marked
// step as incomplete. Deleting a marker by hand is a deliberate act; nothing in the environment can stop one being written.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// [ppid, start time] of pid, or null when it has gone. Linux: /proc/<pid>/stat; elsewhere ps.
function proc(pid) {
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); return [Number(st[1]), st[19]]; } catch { return null; }
  }
  const r = spawnSync('ps', ['-o', 'ppid=,lstart=', '-p', String(pid)], { encoding: 'utf8' }), m = r.stdout?.trim().match(/^(\d+)\s+(.+)$/);
  return m ? [Number(m[1]), m[2].replace(/\W+/g, '-')] : null;
}
const idOf = pid => { const p = proc(pid); return p && `${pid}-${p[1]}`; };
// The per-user directory: /run/user/<uid>/eng-gates where the user's runtime dir exists, otherwise /tmp/eng-gates-<uid>.
// Owned by the uid and mode 0700, or eng refuses to use it.
function base() {
  const uid = process.getuid?.() ?? 0, run = `/run/user/${uid}`;
  const d = fs.statSync(run, { throwIfNoEntry: false })?.uid === uid ? path.join(run, 'eng-gates') : `/tmp/eng-gates-${uid}`;
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = fs.statSync(d);
  if (st.uid !== uid || (st.mode & 0o077)) throw new Error(`${d} is not private to uid ${uid}`);
  return d;
}
const repoFile = d => path.join(d, 'repo');

// Called by an enclosing eng gate or eng run. Returns take(match): the markers addressed to this process whose key (the
// pid of the process directly below it, or the scope unit) satisfies match, removed as they are read. Its directory goes at exit.
export function enclose(repo) {
  const b = base(), dir = path.join(b, idOf(process.pid));
  for (const d of fs.readdirSync(b)) { const [pid, ...start] = d.split('-'); if (idOf(Number(pid)) !== `${pid}-${start.join('-')}`) fs.rmSync(path.join(b, d), { recursive: true, force: true }); }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(repoFile(dir), repo);
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return match => {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (f === 'repo' || !match(f.slice(0, f.lastIndexOf('.')))) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
      fs.rmSync(path.join(dir, f), { force: true });
    }
    return [...new Map(out.map(m => [m.pid, m])).values()];
  };
}

// Called by a gate that ends incomplete: a marker for every enclosing eng gate or eng run of the same repo.
export function tellEnclosing(repo, deferred) {
  let b; try { b = base(); } catch { return; }
  const mark = (id, key) => {
    const d = path.join(b, id);
    try { if (fs.readFileSync(repoFile(d), 'utf8') === repo) fs.writeFileSync(path.join(d, `${key}.${process.pid}`), JSON.stringify({ pid: process.pid, deferred })); } catch {}
  };
  for (let pid = process.pid, p = proc(pid); p && p[0] > 1; pid = p[0], p = proc(pid)) { const id = idOf(p[0]); if (id) mark(id, pid); }
  let cg = ''; try { cg = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch {}
  // The scope name (systemd path), and the watchdog's inherited unit tag for a gate that left the process tree.
  for (const u of [cg.match(/\/(eng-[a-z0-9-]+)\.scope$/m)?.[1], process.env.ENG_BUDGET_UNIT]) {
    const pid = u?.match(/^eng-[a-z0-9-]*-(\d+)-\d+-[a-z0-9]+$/)?.[1], id = pid && idOf(Number(pid));
    if (id) mark(id, u);
  }
}

// eng lint: a checks-dir script that runs eng gate (eng, eng.mjs, npx eng, or a variable named for eng). Comment lines and
// quoted text are skipped. A line that means it carries `# nested gate: <why>`, a visible trace for the reviewer.
export const NESTED_GATE_RULE = {
  id: 'check-runs-gate',
  pattern: '^(?!\\s*#)(?!.*#\\s*nested gate: \\S).*((^|[\\s;&|(`/])(eng|eng\\.mjs)|\\$\\{?\\w*(eng|ENG)\\w*\\}?"?)\\s+gate(\\s|$|[;&|)])',
  flags: '',
  message: 'A check is a leaf: it never runs eng gate; the gate composes the checks. Put what this check runs in the check itself, or make it its own check. A gate inside a check that defers anything makes the enclosing gate incomplete (exit 3) anyway. If the nested gate is the subject under test (a fixture repo), end the line with # nested gate: <why>.',
};
