// eng run: the one runner. `eng run [--by <id>] [--ref <ref>] -- <cmd>` runs a command in a private 0700 worktree of the exact
// commit (HEAD unless --ref) under the repo's scratch root, and removes it on exit, pass or fail (and on SIGINT/SIGTERM/SIGHUP).
// With --by the run is verdict evidence (lib/verification.mjs). --keep is the persistent form, removed with `eng run down <dir>`
// (no --force: git refuses dirty work). A declared run in the checkout (`eng run <name>`) is lib/ephemeral.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { slug, quoteArg, openRound, tmpBase } from './hygiene.mjs';
import { recordRun, runLog, tail } from './verification.mjs';

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
let launchChild = null, launchPrep = null, launchSig = 0, onLaunchSignal = () => {};
export const RUN_USAGE = 'usage: eng run [--by <verifier-id>] [--ref <ref>] -- <command>   (private worktree of the exact commit, removed on exit; with --by the run is verdict evidence) | eng run --keep [--ref <ref>] | eng run down <dir> | eng run <name> | eng run --here -- <command>';
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
  const by = opt('--by'), ref = opt('--ref') || 'HEAD';
  if ((cmd && !cmd.length) || (!cmd && !opts.includes('--keep')) || (by && !cmd)) die(RUN_USAGE);
  let cfg = null; try { cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'eng.config.yml'), 'utf8')); } catch {}
  const name = cfg?.project?.name || path.basename(path.dirname(path.resolve(ROOT, sh('git rev-parse --git-common-dir'))));
  const rcfg = { ...(cfg || {}), project: { ...(cfg?.project || {}), name } };
  const modeOf = p => (fs.statSync(p).mode & 0o777).toString(8), rootBefore = modeOf(ROOT);
  let dir, tmp, env = null, round = null;
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
      startRound();
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
    // Async so a signal to eng reaches the command: forward it, escalate to SIGKILL after 10s, then exit 128+n (the exit trap removes the round).
    // Non-interactive: its own process group, so a signal reaches every descendant (a shell's children too). On a TTY it stays
    // in the terminal's group so it can read the terminal. Either way the close hook (newest first, so before the round dir
    // goes) SIGKILLs everything the round started: the group, live descendants, and any process whose environment carries this
    // round's ENG_SCRATCH. That last check catches a background worker re-parented to init after its shell exits.
    {
      const detached = !process.stdin.isTTY;
      // A run with --by tees its output, so the run log keeps the tail as evidence (lib/verification.mjs). Its cmd is the quoted
      // argv: `sh -c 'exit 7'` and `sh -c exit 7` are different commands, so one never supersedes the other's failure.
      const child = spawn(cmd[0], cmd.slice(1), { cwd: wt, env, stdio: by ? ['inherit', 'pipe', 'pipe'] : 'inherit', detached }); launchChild = child;
      let output = '';
      if (by) for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) from.on('data', d => { to.write(d); output = tail(output + d); });
      const group = s => { if (!(child.pid > 1)) return; try { detached ? process.kill(-child.pid, s) : child.kill(s); } catch {} };
      round.onClose(() => { group('SIGKILL'); for (const p of new Set([...descendants(child.pid), ...roundProcs(dir)])) { try { process.kill(p, 'SIGKILL'); } catch {} } });
      onLaunchSignal = s => { group(s); setTimeout(() => group('SIGKILL'), 10e3).unref(); };
      child.on('error', e => { console.error(`eng run: cannot run ${cmd[0]}: ${e.message}`); process.exit(127); });
      // A run with --by waits for its pipes to drain (at most 2s after exit, in case a background process holds them).
      let done = false;
      const finish = (status, signal) => {
        if (done) return; done = true;
        const code = launchSig ? 128 + launchSig : status ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
        if (by) {
          recordRun(runLog(sh('git rev-parse --path-format=absolute --git-common-dir')), { sha, by, cmd: cmd.map(quoteArg).join(' '), exit: code, output, at: new Date().toISOString() });
          console.log(`eng run: recorded the run by ${by} on ${sha.slice(0, 8)} (exit ${code}) as verdict evidence`);
        }
        console.log(`eng run: command exited ${code}; removing round ${path.basename(dir)}`);
        process.exit(code);
      };
      child.on('exit', (status, signal) => by ? setTimeout(() => finish(status, signal), 2e3) : finish(status, signal));
      if (by) child.on('close', finish);
    }
    return;
  }
  const st = { repo: ROOT, worktree: wt, tmp, ref, sha, modes, repo_mode: rootAfter, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  console.log(`  worktree ${wt} (mode ${modes.worktree}) at ${ref} ${sha.slice(0, 8)}\n  tmp      ${tmp} (mode ${modes.tmp})\n  shared checkout ${ROOT} left at mode ${rootAfter}`);
  console.log(`eng run: ready (--keep). cd ${wt} && export TMPDIR=${tmp}   (remove: eng run down ${dir})`);
  }
}
