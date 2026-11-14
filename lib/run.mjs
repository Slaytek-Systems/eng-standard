// eng run: the one runner. `eng run [--by <id>] [--ref <ref>] -- <cmd>` runs a command in a private 0700 worktree of the exact
// commit (HEAD unless --ref) under the repo's scratch root, and removes it on exit, pass or fail (and on SIGINT/SIGTERM/SIGHUP).
// With --by the run is verdict evidence (lib/verification.mjs). --keep is the persistent form, removed with `eng run down <dir>`
// (no --force: git refuses dirty work). A declared run in the checkout (`eng run <name>`) is lib/ephemeral.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { slug, quoteArg, openRound, tmpBase, openSockDir, staleSockDirs, runTmpRoot } from './hygiene.mjs';
import { recordRun, runLog, tail, RUN_KEY_VERSION, runStatusContext, runStatusBy, runStatusText, githubRepo, RUN_GRACE_S } from './verification.mjs';
import { enclose } from './nested.mjs';
import { DEFAULT_BUDGET, parseBudget, budgetText, startBounded, enforcer, enforcerText } from './budget.mjs';

// Every live descendant of pid (Linux /proc), so nothing a round started outlives it.
function descendants(pid) {
  const kids = new Map();
  try { for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) { try { const pp = Number(fs.readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); (kids.get(pp) || kids.set(pp, []).get(pp)).push(Number(d)); } catch {} } } catch { return []; }
  const out = [], todo = [pid];
  while (todo.length) for (const k of kids.get(todo.pop()) || []) { out.push(k); todo.push(k); }
  return out;
}
// Every live process (other than eng) whose environment has ENG_SCRATCH=<round dir>: all a round started, re-parented or not.
function roundProcs(dir) {
  const want = `ENG_SCRATCH=${dir}`, out = [];
  try { for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x) && Number(x) > 1 && Number(x) !== process.pid && Number(x) !== process.ppid)) { try { if (fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(want)) out.push(Number(d)); } catch {} } } catch {}
  return out;
}
// With --by, the run shows on GitHub while it runs: commit status eng-run/<by>/<command hash>-<run id> is pending on the run's
// commit until the command ends, then success or failure (lib/verification.mjs). Self-merge does not count that verifier's PASS
// while it is pending. Only a clone whose origin is on github.com marks anything; a failed post never stops the run.
function runStatus(root, sha, by, cmdText, timeoutS) {
  const o = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }), repo = o.status === 0 ? githubRepo(o.stdout) : null;
  const context = runStatusContext(by, cmdText, randomBytes(4).toString('hex'));
  let live = !!repo;
  return (state, exit) => {
    if (!live) return;
    const p = spawnSync('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${runStatusText(by, { timeoutS, exit }, cmdText)}`], { encoding: 'utf8', timeout: 15e3, stdio: ['ignore', 'ignore', 'pipe'] });
    if (p.status === 0) return;
    live = false;
    const why = (p.stderr || p.error?.message || `gh exited ${p.status}`).trim().split('\n')[0];
    console.error(state === 'pending'
      ? `eng run: could not mark this run in progress on GitHub (${why}); self-merge cannot see this run, so it will not hold back ${by}'s PASS`
      : `eng run: could not post this run's result to GitHub (${why}); its ${context} status stays pending, holding back ${by}'s PASS for at most ${timeoutS + RUN_GRACE_S}s after it started, unless this gh login posts its end first: gh api -X POST repos/${repo}/statuses/${sha} -f state=error -f context=${context}`);
  };
}
// The worktree holds tracked files only. When every lockfile in every folder of the commit matches the checkout's byte for
// byte, each of the checkout's node_modules folders (the root's and each workspace's) is mounted at the same place in the
// worktree with fuse-overlayfs: the checkout's folder is the read-only lower layer and the run's writes land in an upper
// layer in the round, so no download, no copy, and nothing the command does reaches the checkout. Otherwise eng says why
// and the command installs its own. Returns null (no lockfile anywhere), { why } or { mounts: [{ rel, src, dst }] }.
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
function depsFrom(root, wt) {
  const read = p => { try { return fs.readFileSync(p); } catch { return null; } };
  const tree = spawnSync('git', ['-C', wt, 'ls-tree', '-r', '-d', '-z', '--name-only', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (tree.status !== 0) return { why: `git ls-tree failed: ${tree.stderr.trim()}` };
  const dirs = ['', ...tree.stdout.split('\0').filter(Boolean)];
  const tracked = dirs.find(d => d.split('/').includes('node_modules'));
  const locks = dirs.filter(d => !d.split('/').includes('node_modules')).flatMap(d => LOCKFILES.map(f => [path.join(d, f), read(path.join(wt, d, f)), read(path.join(root, d, f))])).filter(([, a, b]) => a || b);
  if (!locks.length) return null;
  if (tracked) return { why: `the commit tracks ${tracked}` };
  const off = locks.find(([, a, b]) => !a || !b || !a.equals(b));
  if (off) return { why: !off[2] ? `${off[0]} is at the commit but not in ${root}` : !off[1] ? `${off[0]} is in ${root} but not at the commit` : `${off[0]} differs between the commit and ${root}` };
  const mounts = dirs.map(d => path.join(d, 'node_modules')).filter(rel => fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false })?.isDirectory())
    .map(rel => ({ rel, src: path.join(root, rel), dst: path.join(wt, rel) }));
  return mounts.length ? { mounts } : { why: `${root} has no node_modules folder` };
}
const unmount = p => spawnSync('fusermount3', ['-u', '-z', p]).status === 0 || spawnSync('fusermount', ['-u', '-z', p]).status === 0;
const noDeps = why => console.error(`eng run: no node_modules in the worktree (${why}); a command that needs the dependencies installs them itself, e.g. eng run -- sh -c 'npm ci && npm test'`);
let launchChild = null, launchPrep = null, launchSig = 0, onLaunchSignal = () => {};
export const RUN_USAGE = 'usage: eng run [--by <verifier-id>] [--ref <ref>] -- <command>   (private worktree of the exact commit, removed on exit; with --by the run is verdict evidence; under the default budget, or --budget "memory=<size> workers=<n> timeout=<duration>" before --) | eng run --keep [--ref <ref>] | eng run down <dir> | eng run <name> | eng run --here -- <command>';
export function scratchRun(ctx, args) {
  const { ROOT, sh, die } = ctx, dd = args.indexOf('--'), cmd = dd >= 0 ? args.slice(dd + 1) : null, opts = dd >= 0 ? args.slice(0, dd) : args;
  // Only the options before `--`: a --by or --ref inside the command is the command's own.
  const opt = k => opts.includes(k) ? opts[opts.indexOf(k) + 1] || die(RUN_USAGE) : null;
  if (opts[0] === 'down') {
    const dir = path.resolve(opts[1] || die('usage: eng run down <dir>')), st = JSON.parse(fs.existsSync(path.join(dir, 'launch.json')) ? fs.readFileSync(path.join(dir, 'launch.json'), 'utf8') : die(`run down: ${dir} has no launch.json (not made by eng run --keep)`));
    const r = spawnSync('git', ['-C', st.repo, 'worktree', 'remove', st.worktree], { encoding: 'utf8' }); // no --force: git refuses a dirty worktree
    if (r.status !== 0) die(`run down: git refused (${r.stderr.trim()}); commit or report the work first`);
    fs.rmSync(dir, { recursive: true, force: true });
    return console.log(`eng run down: removed ${st.worktree} and ${dir}`);
  }
  const by = opt('--by'), ref = opt('--ref') || 'HEAD', given = opt('--budget'), parsed = given === null ? {} : parseBudget(given);
  if (by !== null && runStatusBy(runStatusContext(by, '', '0')) !== by) die(`run: --by ${JSON.stringify(by)} cannot name a run status (eng-run/<verifier>/<8 hex>-<run id>, the verifier one segment with no space or /), so self-merge would refuse every PR it runs on; pick another id`);
  if (parsed.error) die(`run: --budget ${parsed.error}`);
  const budget = { ...DEFAULT_BUDGET, ...parsed };
  let how; try { how = cmd ? enforcer() : null; } catch (e) { die(`run: ${e.message}`); }
  if ((cmd && !cmd.length) || (!cmd && !opts.includes('--keep')) || (by && !cmd)) die(RUN_USAGE);
  let cfg = null; try { cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'eng.config.yml'), 'utf8')); } catch {}
  const name = cfg?.project?.name || path.basename(path.dirname(path.resolve(ROOT, sh('git rev-parse --git-common-dir'))));
  const rcfg = { ...(cfg || {}), project: { ...(cfg?.project || {}), name } };
  const modeOf = p => (fs.statSync(p).mode & 0o777).toString(8), rootBefore = modeOf(ROOT);
  let dir, tmp, env = null, round = null;
  // A gate inside the command that ended incomplete signals this run (lib/nested.mjs), so `eng gate | cat` is incomplete too.
  // It listens before git makes the worktree, since git's post-checkout hook can run a gate, and the window stays open to the end.
  const inner = cmd ? enclose('run') : null, window = inner?.open();
  if (cmd) {
    round = openRound(rcfg, 'run', { trapSignals: false }); ({ dir, tmp, env } = round); // signals go to the command first (below)
    // Handlers from the moment the round exists. While the worktree is being made, a signal stops git and its hooks (their
    // process group) and the round exits through cleanup once git has gone (the exit hook removes the worktree and the dir);
    // the command is never started. Once the command runs, a signal is forwarded to it instead.
    for (const [s, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(s, () => {
      launchSig ||= n;
      if (launchChild) return onLaunchSignal(s);
      if (launchPrep) { const g = launchPrep.pid; try { process.kill(-g, s); } catch {} setTimeout(() => { try { process.kill(-g, 'SIGKILL'); } catch {} }, 10e3).unref(); return; }
      process.exit(128 + n);
    });
    round.onClose(() => { spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', path.join(dir, 'wt')]); spawnSync('git', ['-C', ROOT, 'worktree', 'prune']); });
    // A socket in TMPDIR must fit in 107 bytes (tsx IPC: $TMPDIR/tsx-<uid>/<pid>.pipe), and the round's tmp is as deep as the
    // scratch root and the repo name make it (98 bytes on the devbox). The command's TMPDIR is a folder in its own short folder
    // ($HOME/.cache/eng/t/<8 hex>/<6>), removed with the round; with no usable home it stays the round's.
    const tmpRoot = runTmpRoot(process.env);
    for (const d of staleSockDirs(Infinity, { root: tmpRoot })) if (d.stale) fs.rmSync(d.path, { recursive: true, force: true });
    let own = null; try { own = openSockDir(process.env, `eng-run-${Date.now().toString(36)}-${process.pid}-0`, tmpRoot); } catch {}
    if (own) {
      round.onClose(() => fs.rmSync(own, { recursive: true, force: true }));
      tmp = fs.mkdtempSync(`${own}/`);
      env = { ...env, ENG_TMP: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    }
  } else {
    const base = tmpBase(rcfg); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    dir = fs.mkdtempSync(path.join(base, `eng-run-${slug(name)}-`)); fs.chmodSync(dir, 0o700); // the dir mkdtemp just made; nothing else is chmodded
    tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp, { mode: 0o700 });
  }
  const wt = path.join(dir, 'wt');
  if (cmd) {
    // Not execSync: a signal that arrives while Node is blocked in execSync is handled only after the next setImmediate
    // on Node 20, so the command could start despite it. Run git as a child the event loop waits on: the signal handler
    // runs during the wait, and the command starts only from git's exit, after checking that no signal came.
    const add = spawn('git', ['worktree', 'add', '--detach', wt, ref], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    launchPrep = add;
    let err = ''; add.stderr.on('data', d => { err += d; });
    add.on('error', e => die(`run: cannot run git: ${e.message}`));
    add.on('close', status => {
      launchPrep = null;
      if (launchSig) process.exit(128 + launchSig);
      if (status !== 0) die(`run: git worktree add failed: ${err.trim()}`);
      const deps = depsFrom(ROOT, wt);
      if (!deps?.mounts) { if (deps) noDeps(deps.why); return startRound(); }
      // Unmounted before the worktree goes (close hooks run newest first). The daemon gets eng's env, not the round's, so
      // the round's process sweep leaves it to the unmount.
      const mounted = [];
      round.onClose(() => { for (const p of mounted.reverse()) unmount(p); });
      const next = i => {
        if (i === deps.mounts.length) { console.log(`  node_modules: ${deps.mounts.map(m => m.rel).join(', ')} from ${ROOT}, read-only under the run's own overlay (every lockfile matches the commit)`); return startRound(); }
        const { rel, src, dst } = deps.mounts[i], layer = path.join(dir, 'deps', String(i));
        for (const p of [dst, `${layer}/upper`, `${layer}/work`]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
        const fo = spawn('fuse-overlayfs', ['-o', `lowerdir=${src},upperdir=${layer}/upper,workdir=${layer}/work`, dst], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        launchPrep = fo;
        let err = ''; fo.stderr.on('data', d => { err += d; });
        fo.on('error', e => { err ||= e.code === 'ENOENT' ? 'not installed' : e.message; });
        fo.on('close', code => {
          launchPrep = null;
          if (code === 0) mounted.push(dst);
          if (launchSig) process.exit(128 + launchSig);
          if (code === 0) return next(i + 1);
          for (const p of mounted.splice(0).reverse()) unmount(p);
          for (const m of deps.mounts) fs.rmSync(m.dst, { recursive: true, force: true });
          noDeps(`fuse-overlayfs failed on ${rel}: ${err.trim().split('\n')[0] || `exit ${code}`}`);
          startRound();
        });
      };
      next(0);
    });
    return;
  }
  sh(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(ref)}`);
  startRound();
  function startRound() {
  fs.chmodSync(wt, 0o700);
  const modes = { dir: modeOf(dir), worktree: modeOf(wt), tmp: modeOf(tmp) }, rootAfter = modeOf(ROOT);
  if (Object.values(modes).some(m => m !== '700')) die(`run: modes ${JSON.stringify(modes)} are not 700`);
  if (rootAfter !== rootBefore) die(`run: shared checkout mode changed ${rootBefore} -> ${rootAfter}`);
  const sha = sh(`git -C ${JSON.stringify(wt)} rev-parse HEAD`);
  if (cmd) {
    console.log(`  round ${dir} (mode 700, removed on exit)\n  worktree ${wt} at ${ref} ${sha.slice(0, 8)}; TMPDIR=${tmp}; shared checkout ${ROOT} left at mode ${rootAfter}`);
    console.log(`  budget: ${budgetText(budget)} (${given === null ? 'default; set one with --budget' : 'from --budget'}), enforced by ${enforcerText(how)}; JAVA_TOOL_OPTIONS, NODE_OPTIONS and GRADLE_OPTS carry it for this command only`);
    // Async so a signal to eng reaches the command: forward it, escalate to SIGKILL after 10s, then exit 128+n (the exit trap removes the round).
    // Non-interactive: its own process group, so a signal reaches every descendant (a shell's children too). On a TTY it stays
    // in the terminal's group so it can read the terminal. Either way the close hook (newest first, so before the round dir
    // goes) SIGKILLs everything the round started: the group, live descendants, and any process whose environment carries this
    // round's ENG_SCRATCH. That last check catches a background worker re-parented to init after its shell exits.
    {
      const detached = !process.stdin.isTTY;
      // A run with --by tees its output, so the run log keeps the tail as evidence (lib/verification.mjs). Its cmd is the quoted
      // argv: `sh -c 'exit 7'` and `sh -c exit 7` are different commands, so one never supersedes the other's failure.
      // The budget (lib/budget.mjs): a systemd user scope or a watchdog, a timeout, and the tool flags in the env.
      const commonDir = sh('git rev-parse --path-format=absolute --git-common-dir'), cmdText = cmd.map(quoteArg).join(' ');
      const mark = by ? runStatus(ROOT, sha, by, cmdText, budget.timeoutS) : () => {};
      mark('pending');
      const bounded = startBounded(cmd, budget, { label: 'run', how, leftovers: 'kill', cwd: wt, env, stdio: by ? ['inherit', 'pipe', 'pipe'] : 'inherit', detached }), child = bounded.child; launchChild = child;
      let output = '';
      if (by) for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) from.on('data', d => { to.write(d); output = tail(output + d); });
      const closed = by ? new Promise(r => child.on('close', r)) : null;
      const group = s => { if (!(child.pid > 1)) return; try { detached ? process.kill(-child.pid, s) : child.kill(s); } catch {} };
      round.onClose(() => { group('SIGKILL'); for (const p of new Set([...descendants(child.pid), ...roundProcs(dir)])) { try { process.kill(p, 'SIGKILL'); } catch {} } });
      onLaunchSignal = s => { group(s); setTimeout(() => group('SIGKILL'), 10e3).unref(); };
      // A command that cannot start is a failed run (127, from the bounded result), recorded like any other, so an earlier pass of it stops counting.
      child.on('error', e => { console.error(`eng run: cannot run ${cmd[0]}: ${e.message}`); output = tail(`${output}eng run: cannot run ${cmd[0]}: ${e.message}\n`); });
      const finish = (status, signal, nested) => {
        let code = launchSig ? 128 + launchSig : status ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
        if (nested && code === 0) {
          code = 3;
          const m = 'eng run: INCOMPLETE (exit 3): a gate inside the command ended incomplete (exit 3), though the command exited 0; it is not a pass';
          console.error(m); output = tail(`${output}${m}\n`);
        }
        if (by) {
          recordRun(runLog(commonDir), { v: RUN_KEY_VERSION, sha, by, cmd: cmdText, exit: code, output, at: new Date().toISOString() });
          mark(code === 0 ? 'success' : 'failure', code);
          console.log(`eng run: recorded the run by ${by} on ${sha.slice(0, 8)} (exit ${code}) as verdict evidence`);
        }
        console.log(`eng run: command exited ${code}; removing round ${path.basename(dir)}`);
        process.exit(code);
      };
      // One finalisation, from the bounded result: it comes once the whole workload has ended, and a workload its budget
      // stopped never has status 0. A run with --by then waits for its pipes to drain (at most 2s, in case something
      // outside the workload holds them), so the output tail is complete.
      bounded.done.then(async ({ status, signal, why }) => {
        if (why) { const m = `eng: FAIL run: ${cmd[0]} ${why} (${given === null ? 'default' : '--budget'} budget ${budgetText(budget)}; set a bigger one with eng run --budget "memory=<size> workers=<n> timeout=<duration>" -- <cmd>)`; console.error(m); output = tail(`${output}${m}\n`); }
        if (closed) await Promise.race([closed, new Promise(r => setTimeout(r, 2e3).unref())]);
        finish(status, signal, await inner.close(window));
      });
    }
    return;
  }
  const st = { repo: ROOT, worktree: wt, tmp, ref, sha, modes, repo_mode: rootAfter, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  console.log(`  worktree ${wt} (mode ${modes.worktree}) at ${ref} ${sha.slice(0, 8)}\n  tmp      ${tmp} (mode ${modes.tmp})\n  shared checkout ${ROOT} left at mode ${rootAfter}`);
  console.log(`eng run: ready (--keep). cd ${wt} && export TMPDIR=${tmp}   (remove: eng run down ${dir})`);
  }
}
