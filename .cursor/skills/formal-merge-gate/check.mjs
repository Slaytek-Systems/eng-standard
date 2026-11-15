#!/usr/bin/env node
// Bounded model check of eng-standard's self-merge gate. Explores every order of the GitHub events a scenario allows,
// breadth first, and runs the real decide(), parseVerdicts() and verdictBody() (lib/self-merge.mjs) on GitHub-shaped rows
// built with lib/verification.mjs's own run-status encoders, the way scripts/pr-gate.mjs merge() re-checks a PR.
// Properties, judged by rulesHold() below from the event history, never from status rows:
//   read    (default) every merge rule held for the merged head as of the moment self-merge read each input.
//   moment  there was one moment, between the re-check's PR read and the merge call, when every rule held at once.
// Usage: node check.mjs [--property read|moment] [--scenario <name>|all] [--src <checkout>] [--max-states <n>]
// Exit 0: the property holds and every witness was reached. 1: a counterexample, printed as its shortest path.
// 2: unusable result (a witness never reached, the state cap hit) or bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SRC = path.resolve(opt('--src', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')));
const ONLY = opt('--scenario', 'all'), PROPERTY = opt('--property', 'read'), MAX_STATES = Number(opt('--max-states', 1e6));
if (!['read', 'moment'].includes(PROPERTY)) { console.error('--property is read or moment'); process.exit(2); }

const load = p => import(pathToFileURL(path.join(SRC, p)).href);
const { selfMergeConfig, decide, parseVerdicts, verdictBody } = await load('lib/self-merge.mjs');
const { runStatusContext, runStatusText } = await load('lib/verification.mjs');
const YAML = (await import(pathToFileURL(path.join(SRC, 'node_modules/yaml/dist/index.js')).href)).default;
const C = selfMergeConfig(YAML.parse(fs.readFileSync(path.join(SRC, 'eng.config.yml'), 'utf8')));

// The contract (AGENTS.md "Merge rule", docs/self-merge.md "Run guard"), restated here without lib/: a run holds its
// verifier's PASS from its first pending status until its owner or a verifier_logins login ends it, or until first
// pending + timeout + 5 minutes. eng run's budget ends a live run before that deadline, so time never passes a live run's.
// main moves only by a self-merge run (branch protection, nobody merges by hand) and those runs queue one at a time
// (self-merge.yml concurrency), so main never moves while the modeled run is in progress.
const GRACE_S = 300, TIMEOUT_S = 60, CMD = 'npm test';
const VERIFIER = C.verifier_logins?.[0], COLLAB = 'collab';
if (!VERIFIER) { console.error('eng.config.yml sets no ship.self_merge.verifier_logins; this model assumes it does'); process.exit(2); }
const SHAS = ['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222'];
const T0 = Date.parse('2026-11-14T00:00:00Z') / 1000;
const iso = s => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

// Each scenario bounds how many of each environment event one behavior may hold (events: all of them together), which
// verifier names and accounts act, and whether h1 starts with a green test and a success verdict status.
// files: the PR's changed files. results: the verdicts an account may post; ISO is a PASS whose one run is the isolation
// record (ship.self_merge.isolation_record), passing exactly its tests.
const RESULTS = [[VERIFIER, 'PASS'], [VERIFIER, 'FAIL'], [COLLAB, 'PASS']];
const S = { runs: 0, verdicts: 0, verdictStatus: 0, foreign: 0, deaths: 0, jumps: 0, holds: 0, pushes: 0, mainMoves: 0, bys: ['V1'], runAccts: [VERIFIER, COLLAB], preset: true, files: ['lib/example.mjs'], results: RESULTS };
const ISO = C.isolation_record;
if (!ISO) { console.error('eng.config.yml sets no ship.self_merge.isolation_record; the isolation-record scenario assumes it does'); process.exit(2); }
const SCENARIOS = {
  'run-ownership': { ...S, risk: 'low', events: 6, runs: 1, verdicts: 2, foreign: 2, jumps: 1 },
  'dead-runs': { ...S, risk: 'low', events: 6, runs: 2, verdicts: 1, deaths: 1, jumps: 1, runAccts: [VERIFIER] },
  'two-verifiers': { ...S, risk: 'high', events: 5, runs: 1, verdicts: 3, bys: ['V1', 'V2'], runAccts: [VERIFIER] },
  'heads': { ...S, risk: 'low', events: 6, verdicts: 2, verdictStatus: 2, pushes: 1, mainMoves: 1, preset: false },
  'hold-label': { ...S, risk: 'low', events: 4, verdicts: 2, holds: 2 },
  'f1-replay': { ...S, risk: 'low', events: 6, runs: 2, verdicts: 3, runAccts: [VERIFIER], results: RESULTS.filter(([a]) => a === VERIFIER), firstPass: true },
  'isolation-record': { ...S, risk: 'high', events: 6, runs: 1, verdicts: 4, bys: ['V1', 'V2', 'I'], runBys: ['I'], runAccts: [VERIFIER], files: [ISO.paths[0]], results: [[VERIFIER, 'PASS'], [VERIFIER, 'FAIL'], [VERIFIER, 'ISO']] },
};
const needsIso = b => b.risk === 'high' && b.files.some(f => ISO.paths.includes(f));
const WITNESSES = {
  'a merge': w => w.merged,
  'a merge after a push': w => w.merged && w.head === 1,
  'a merge after main moved and the builder updated the branch': w => w.merged && w.main === 1 && w.heads[w.head].base === 1,
  'a refusal on a hold label': w => w.ctrl.pc === 'done' && !w.merged && w.ctrl.hold,
  'a merge after the hold label was removed': w => w.merged && w.used.holds === 2,
  'a merge after a dead run reached its deadline': w => w.merged && w.runs.some(r => r.died && r.endId === null && r.startId <= w.ctrl.statusesUpto && w.ctrl.now >= deadline(r) && readPass(w, r.by)),
  [`a merge after ${VERIFIER} cleared ${COLLAB}'s live run`]: w => w.merged && w.runs.some(r => r.owner === COLLAB && r.how === 'cleared' && !r.died && r.endId <= w.ctrl.statusesUpto && readPass(w, r.by)),
  [`a refusal after ${COLLAB} posted success on ${VERIFIER}'s live run`]: w => w.ctrl.pc === 'done' && !w.merged && w.ctrl.commentsUpto !== undefined && w.ctrl.check === 'success' && !w.ctrl.hold
    && w.runs.some(r => r.owner === VERIFIER && r.endId === null && !r.died && readPass(w, r.by) && w.statuses.some(s => s.id <= w.ctrl.statusesUpto && s.context === r.ctx && s.login === COLLAB && s.state === 'success')),
  'a merge whose first decide() pass ran read by read': w => w.merged && w.ctrl.firstPassRan,
  'a merge with two distinct verifiers': w => w.merged && new Set(w.comments.filter(c => c.login === VERIFIER).map(c => c.by)).size === 2,
  'a merge with an isolation record': w => w.merged && w.comments.some(c => c.n <= w.ctrl.commentsUpto && c.iso),
  'a refusal with two verifiers and no isolation record': w => w.ctrl.pc === 'done' && !w.merged && w.ctrl.commentsUpto !== undefined && w.ctrl.check === 'success'
    && ['V1', 'V2'].every(by => readPass(w, by)) && !w.comments.some(c => c.n <= w.ctrl.commentsUpto && c.iso),
  'a refusal while the isolation record\'s verifier had a run in progress': w => w.ctrl.pc === 'done' && !w.merged && w.ctrl.commentsUpto !== undefined && w.ctrl.check === 'success'
    && ['V1', 'V2'].every(by => readPass(w, by)) && w.runs.some(r => r.by === 'I' && r.startId <= w.ctrl.statusesUpto && r.endId === null)
    && w.comments.filter(c => c.n <= w.ctrl.commentsUpto && c.by === 'I').at(-1)?.iso === true,
};
// The latest verdict by the given verifier among the comments self-merge read is the login's PASS.
const readPass = (w, by) => w.comments.filter(c => c.n <= w.ctrl.commentsUpto && c.sha === w.ctrl.sha && c.login === VERIFIER && c.by === by).at(-1)?.result === 'PASS';
const EXPECT = {
  'run-ownership': ['a merge', `a merge after ${VERIFIER} cleared ${COLLAB}'s live run`, `a refusal after ${COLLAB} posted success on ${VERIFIER}'s live run`],
  'dead-runs': ['a merge', 'a merge after a dead run reached its deadline'],
  'two-verifiers': ['a merge', 'a merge with two distinct verifiers'],
  'f1-replay': ['a merge', 'a merge whose first decide() pass ran read by read'],
  'isolation-record': ['a merge with an isolation record', 'a refusal with two verifiers and no isolation record', 'a refusal while the isolation record\'s verifier had a run in progress'],
  'heads': ['a merge', 'a merge after a push', 'a merge after main moved and the builder updated the branch'],
  'hold-label': ['a merge', 'a refusal on a hold label', 'a merge after the hold label was removed'],
};

const postStatus = (w, sha, context, state, description, login, timeoutS = null) => {
  w.statuses.push({ id: w.statuses.length + 1, sha, context, state, description, login, at: w.clock, timeoutS });
  return w.statuses.length;
};
function init(b) {
  const w = { clock: T0, main: 0, head: 0, heads: [{ base: 0 }], ci: [null], hold: false, statuses: [], comments: [], runs: [], used: {}, ctrl: { pc: 'idle' }, ok: false, merged: false };
  if (b.preset) { w.ci[0] = 'success'; postStatus(w, 0, C.status, 'success', 'eng verdict check', VERIFIER); }
  return w;
}
const clone = w => structuredClone(w);
const room = (w, b) => (w.used.events || 0) < b.events;
const use = (w, k, b) => (w.used[k] || 0) < b[k] && room(w, b);
const spend = (w, k) => { w.used[k] = (w.used[k] || 0) + 1; w.used.events = (w.used.events || 0) + 1; };

// ---------- the spec: every merge rule, judged from what happened ----------
// v: what one judgment sees. sha: the head being merged; head, hold, main, ci, now: the PR's head, its hold label, main's
// tip, the test result on sha and the clock; statusesUpto, commentsUpto: the status ids and comments that existed.
// isoRule: a risk:high change to an isolation_record path. Then one verifier whose latest verdict is a PASS whose runs passed
// exactly the isolation tests, with no run in progress, is the isolation record, and the other verifiers must still reach
// need (AGENTS.md "Isolation record": it is not one of the N verifiers).
const deadline = r => r.start + TIMEOUT_S + GRACE_S;
function rulesHold(w, v, need, isoRule) {
  if (v.sha !== v.head || v.hold || w.heads[v.sha].base < v.main || v.ci !== 'success') return false;
  if (w.statuses.filter(s => s.sha === v.sha && s.context === C.status && s.id <= v.statusesUpto).at(-1)?.state !== 'success') return false;
  const latest = new Map();
  for (const c of w.comments) if (c.n <= v.commentsUpto && c.sha === v.sha && c.login === VERIFIER) latest.set(c.by, c);
  if ([...latest.values()].some(c => c.result !== 'PASS')) return false;
  const running = by => w.runs.some(r => r.by === by && r.sha === v.sha && r.startId <= v.statusesUpto && !(r.endId !== null && r.endId <= v.statusesUpto) && v.now < deadline(r));
  const counted = [...latest.keys()].filter(by => !running(by));
  if (!isoRule) return counted.length >= need;
  const records = counted.filter(by => latest.get(by).iso);
  return records.length >= 1 && counted.length - records.length >= need;
}
const nowView = (w, sha) => ({ sha, head: w.head, hold: w.hold, main: w.main, ci: w.ci[sha], now: w.clock, statusesUpto: Infinity, commentsUpto: Infinity });
const readView = c => ({ sha: c.sha, head: c.sha, hold: c.hold, main: c.tip, ci: c.check, now: c.now, statusesUpto: c.statusesUpto, commentsUpto: c.commentsUpto });

// ---------- what GitHub returns, built with the product's own encoders ----------
// The isolation record's run, as node --test's spec reporter prints it (docs/self-merge.md "Isolation record").
const ISO_CMD = 'node --test test/ephemeral.test.mjs';
const ISO_OUTPUT = [...ISO.tests.map(t => `✔ ${t} (12.3ms)`), `ℹ tests ${ISO.tests.length}`, `ℹ pass ${ISO.tests.length}`, 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n');
const statusRows = (w, sha, upto) => w.statuses.filter(s => s.sha === sha && s.id <= upto).reverse()
  .map(s => ({ id: s.id, state: s.state, context: s.context, description: s.description, creator: { login: s.login }, created_at: iso(s.at), updated_at: iso(s.at) }));
const commentRows = (w, upto) => w.comments.filter(c => c.n <= upto).map(c => {
  const sha = SHAS[c.sha];
  const run = c.iso ? { cmd: ISO_CMD, exit: 0, output: ISO_OUTPUT, sha } : { cmd: CMD, exit: 0, output: 'ok', sha };
  const rec = { sha, result: c.result, by: c.by, method: 'verification', runs: [run], patch_id: 'f'.repeat(40), at: iso(c.at) };
  return { body: verdictBody(rec), user: { login: c.login }, author_association: c.login === VERIFIER ? 'OWNER' : 'COLLABORATOR', created_at: iso(c.at), updated_at: iso(c.at) };
});
function evaluate(w, c, risk, files) {
  const pr = { number: 1, base: C.base, draft: false, sameRepo: true, headSha: SHAS[c.sha], labels: [risk === 'high' ? C.high_label : C.low_label, ...(c.hold ? [C.hold_label] : [])] };
  const check = c.check ? { head_sha: SHAS[c.sha], status: 'completed', conclusion: c.check } : null;
  return decide(pr, { risk, files, check, statuses: statusRows(w, c.sha, c.statusesUpto), now: c.now * 1000, containsBase: c.containsBase, verdicts: parseVerdicts(commentRows(w, c.commentsUpto)) }, C);
}

// ---------- environment events: one GitHub write (or one change in the world) each ----------
function envMoves(w, b) {
  const out = [], m = (label, f) => { const n = clone(w); f(n); out.push([label, n]); };
  const h = w.head, hs = `h${h + 1}`;
  if (use(w, 'runs', b)) for (const by of b.runBys ?? b.bys) for (const a of b.runAccts) m(`${a} starts eng run --by ${by} on ${hs}: run r${w.runs.length + 1} posts pending on its eng-run/${by}/... context (timeout ${TIMEOUT_S}s)`, n => {
    spend(n, 'runs'); const id = `r${n.runs.length + 1}`, ctx = runStatusContext(by, CMD, id);
    const startId = postStatus(n, h, ctx, 'pending', runStatusText(by, { timeoutS: TIMEOUT_S }, CMD), a, TIMEOUT_S);
    n.runs.push({ id, by, owner: a, sha: h, ctx, start: n.clock, startId, endId: null, how: null, died: false });
  });
  for (const [i, r] of w.runs.entries()) {
    if (r.endId !== null) continue;
    if (!r.died) m(`run ${r.id} (${r.owner}, --by ${r.by}) ends: its eng posts success`, n => { n.runs[i].endId = postStatus(n, r.sha, r.ctx, 'success', runStatusText(r.by, { exit: 0 }, CMD), r.owner); n.runs[i].how = 'ended'; });
    if (!r.died && use(w, 'deaths', b)) m(`run ${r.id} (${r.owner}, --by ${r.by}) dies: its eng is killed and posts nothing`, n => { spend(n, 'deaths'); n.runs[i].died = true; });
    if (!use(w, 'foreign', b)) continue;
    m(`${VERIFIER} clears run ${r.id} by hand: posts error on its context`, n => { spend(n, 'foreign'); n.runs[i].endId = postStatus(n, r.sha, r.ctx, 'error', 'cleared by hand: the run died', VERIFIER); n.runs[i].how = 'cleared'; });
    if (r.owner === COLLAB) continue;
    m(`${COLLAB} posts success on run ${r.id}'s context`, n => { spend(n, 'foreign'); postStatus(n, r.sha, r.ctx, 'success', runStatusText(r.by, { exit: 0 }, CMD), COLLAB); });
    m(`${COLLAB} posts pending (timeout 0s) on run ${r.id}'s context`, n => { spend(n, 'foreign'); postStatus(n, r.sha, r.ctx, 'pending', runStatusText(r.by, { timeoutS: 0 }, CMD), COLLAB, 0); });
  }
  if (use(w, 'verdicts', b)) for (const by of b.bys) for (const [a, kind] of b.results)
    m(kind === 'ISO' ? `${a} posts eng verdict PASS --by ${by} for ${hs}, its one run the isolation record` : `${a} posts eng verdict ${kind} --by ${by} for ${hs}`, n => {
      spend(n, 'verdicts'); n.comments.push({ n: n.comments.length + 1, sha: h, by, result: kind === 'ISO' ? 'PASS' : kind, iso: kind === 'ISO', login: a, at: n.clock });
    });
  if (use(w, 'verdictStatus', b)) m(`${VERIFIER} sets the verdict status on ${hs} to success`, n => { spend(n, 'verdictStatus'); postStatus(n, h, C.status, 'success', 'eng verdict check', VERIFIER); });
  if (w.ci[h] === null && room(w, b)) m(`ci finishes on ${hs}: ${C.check} success`, n => { n.ci[h] = 'success'; n.used.events = (n.used.events || 0) + 1; });
  if (use(w, 'mainMoves', b) && w.ctrl.pc === 'idle') m(`another PR merges: main moves to m${w.main + 2}`, n => { spend(n, 'mainMoves'); n.main++; });
  if (use(w, 'pushes', b)) m(`the builder pushes h${w.heads.length + 1}, which contains m${w.main + 1}`, n => { spend(n, 'pushes'); n.heads.push({ base: n.main }); n.ci.push(null); n.head = n.heads.length - 1; });
  if (use(w, 'holds', b)) m(w.hold ? 'the hold label is removed' : 'the hold label is added', n => { spend(n, 'holds'); n.hold = !n.hold; });
  if (use(w, 'jumps', b)) {
    const live = w.runs.filter(r => r.endId === null && !r.died).map(deadline);
    const targets = new Set(w.statuses.filter(s => s.state === 'pending').flatMap(s => [s.at + s.timeoutS + GRACE_S - 1, s.at + s.timeoutS + GRACE_S]));
    for (const t of targets) if (t > w.clock && live.every(d => d > t)) m(`time passes to ${iso(t)}`, n => { spend(n, 'jumps'); n.clock = t; });
  }
  return out;
}

// ---------- the controller: scripts/pr-gate.mjs merge() for one PR, one GitHub read per step ----------
// merge() reads main's tip, then the PR, then runs evaluate() once to decide whether to re-check. That first pass only
// gates the re-check, so the model lets it pass every time: more behaviors than the code has, never fewer. The re-check
// (the PR and main again, then prState: statuses, test check, compare, comments) and the merge call go read by read.
function ctrlMoves(w, { risk, firstPass, files }) {
  const n = clone(w), c = n.ctrl, one = s => [[s, n]];
  switch (c.pc) {
    case 'idle': c.tip = n.main; c.pc = 'pr'; return one(`self-merge starts and reads main's tip (m${n.main + 1})`);
    case 'pr':
      c.sha = n.head;
      if (firstPass) { c.hold = n.hold; c.first = true; c.pc = 's'; return one(`self-merge reads the PR (head h${n.head + 1})${n.hold ? ', hold label on' : ''}; its first decide() pass reads below`); }
      c.pc = 'again'; return one(`self-merge reads the PR (head h${n.head + 1}); its first decide() pass is taken as merge`);
    case 'again':
      if (n.head !== c.sha || n.main !== c.tip) { c.pc = 'done'; return one('self-merge re-reads the PR and main: changed, skip'); }
      c.hold = n.hold; c.pc = 's';
      return one(`self-merge re-reads the PR and main: unchanged${n.hold ? ', hold label on' : ''}`);
    case 's': c.statusesUpto = n.statuses.length; c.pc = 'k'; return one(`self-merge reads the ${n.statuses.filter(s => s.sha === c.sha).length} statuses on h${c.sha + 1}`);
    case 'k': c.check = n.ci[c.sha]; c.now = n.clock; c.pc = 'b'; return one(`self-merge reads the ${C.check} check on h${c.sha + 1} (${c.check ?? 'none'})`);
    case 'b': c.containsBase = n.heads[c.sha].base >= c.tip; c.pc = 'v'; return one(`self-merge compares m${c.tip + 1}...h${c.sha + 1}: ${c.containsBase ? 'contains' : 'behind'}`);
    case 'v': {
      c.commentsUpto = n.comments.length;
      const d = evaluate(n, c, risk, files);
      const first = c.first;
      if (first) { delete c.first; c.firstPassRan = true; }
      c.pc = d.merge ? (first ? 'again' : 'put') : 'done';
      return one(`self-merge reads ${n.comments.length} comment(s); ${first ? 'the first ' : ''}decide() says ${d.merge ? 'merge' : 'skip'}: ${d.reason}`);
    }
    case 'put':
      if (n.head !== c.sha) { c.pc = 'done'; return one(`self-merge calls merge pinned to h${c.sha + 1}: GitHub refuses, the head moved`); }
      n.merged = true; c.pc = 'done';
      return one(`self-merge squash-merges h${c.sha + 1}`);
  }
  return [];
}
const inWindow = c => !c.first && ['s', 'k', 'b', 'v', 'put'].includes(c.pc);

function check(name) {
  const b = SCENARIOS[name], need = b.risk === 'high' ? C.high_verifiers : 1, isoRule = needsIso(b);
  const key = w => createHash('sha1').update(JSON.stringify(w)).digest('base64');
  const start = init(b), seen = new Map([[key(start), null]]), found = new Set();
  const labels = [], ids = new Map(), intern = a => { if (!ids.has(a)) { ids.set(a, labels.length); labels.push(a); } return ids.get(a); };
  const trace = k => { const out = []; for (let e = seen.get(k); e; e = seen.get(e.p)) out.unshift(labels[e.a]); return out; };
  let frontier = [start], states = 1, merges = 0;
  while (frontier.length) {
    const next = [];
    for (const w of frontier) {
      if (w.ctrl.pc === 'done') continue;
      const wk = key(w);
      for (const [a, n] of [...ctrlMoves(w, b), ...envMoves(w, b)]) {
        if (PROPERTY === 'moment' && !n.ok && (inWindow(n.ctrl) || n.merged)) n.ok = rulesHold(n, nowView(n, n.ctrl.sha), need, isoRule);
        const nk = key(n);
        if (seen.has(nk)) continue;
        seen.set(nk, { p: wk, a: intern(a) });
        if (++states > MAX_STATES) return { error: `stopped at --max-states ${MAX_STATES}, so nothing is proven` };
        for (const k of EXPECT[name]) if (!found.has(k) && WITNESSES[k](n)) found.add(k);
        if (n.merged) {
          merges++;
          if (!(PROPERTY === 'moment' ? n.ok : rulesHold(n, readView(n.ctrl), need, isoRule))) return { ok: false, states, trace: trace(nk) };
        }
        next.push(n);
      }
    }
    frontier = next;
  }
  return { ok: true, states, merges, missing: EXPECT[name].filter(k => !found.has(k)) };
}

if (ONLY !== 'all' && !SCENARIOS[ONLY]) { console.error(`unknown --scenario ${ONLY}; one of ${Object.keys(SCENARIOS).join(', ')}, all`); process.exit(2); }
const PROP = PROPERTY === 'read' ? 'RulesHeldWhenRead' : 'MergeMatchesAMoment';
let code = 0;
for (const name of ONLY === 'all' ? Object.keys(SCENARIOS) : [ONLY]) {
  const t = Date.now(), r = check(name), s = `${((Date.now() - t) / 1000).toFixed(1)}s`, risk = `risk:${SCENARIOS[name].risk}`;
  if (r.error) { console.log(`INCOMPLETE ${PROP} ${name} (${risk}): ${r.error}`); code ||= 2; }
  else if (!r.ok) {
    console.log(`FAIL ${PROP} ${name} (${risk}): self-merge merged a head the merge rule did not allow (${r.states} states, ${s}). Shortest path:`);
    r.trace.forEach((a, i) => console.log(`  ${String(i + 1).padStart(2)}. ${a}`));
    code = 1;
  } else if (r.missing.length) { console.log(`VACUOUS ${PROP} ${name} (${risk}): held, but never reached ${r.missing.join('; ')} (${r.states} states, ${s})`); code ||= 2; }
  else console.log(`PASS ${PROP} ${name} (${risk}): ${r.states} states, ${r.merges} merges, every witness reached, ${s}`);
}
process.exit(code);
