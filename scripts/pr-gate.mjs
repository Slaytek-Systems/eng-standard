#!/usr/bin/env node
// eng-standard's own merge automation (v0.9.1). Run by .github/workflows/risk-label.yml and self-merge.yml, always
// from main's code. Uses `gh api` with GH_TOKEN (the workflow's GITHUB_TOKEN). Rules: AGENTS.md "Merge rule".
//   node scripts/pr-gate.mjs label <n> [--dry-run]     set risk:high or risk:low from the PR's changed paths
//   node scripts/pr-gate.mjs merge [--pr <n>] [--dry-run]   squash-merge at most ONE eligible PR, then run ci.yml on main;
//                                                            on a red main, open the tip's auto-revert instead
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { classifyRisk, versionOnly } from '../lib/risk.mjs';
import { selfMergeConfig, decide, parseVerdicts, authorsFrom, isAutoRevert, REVERT_MARK } from '../lib/self-merge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'eng.config.yml'), 'utf8'));
const C = selfMergeConfig(cfg), HR = cfg.ship.high_risk;
const R = process.env.GITHUB_REPOSITORY || 'Mattslayga/eng-standard';
const [cmd, ...a] = process.argv.slice(2);
const dry = a.includes('--dry-run');
const opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };

function gh(args, input) {
  const r = spawnSync('gh', ['api', ...args], { encoding: 'utf8', input });
  if (r.status !== 0) { const e = new Error(`gh api ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`); e.out = r.stdout; throw e; }
  return r.stdout;
}
const get = p => JSON.parse(gh([p]) || 'null');
const pages = p => JSON.parse(gh(['--paginate', '--slurp', p])).flat();
const send = (method, p, body) => gh(['-X', method, p, '--input', '-'], JSON.stringify(body ?? {}));
const raw = (file, sha) => { try { return gh(['-H', 'Accept: application/vnd.github.raw', `repos/${R}/contents/${encodeURIComponent(file).replaceAll('%2F', '/')}?ref=${sha}`]); } catch { return null; } };

// GitHub lists at most 3,000 files and 250 commits for a PR. A list shorter than the PR's own count is incomplete, and an
// incomplete list is never evidence: files unknown are risk:high, authors unknown refuse the merge.
const full = pr => Number.isInteger(pr.changed_files) && Number.isInteger(pr.commits) ? pr : get(`repos/${R}/pulls/${pr.number}`);

function riskFor(pr) {
  const files = pages(`repos/${R}/pulls/${pr.number}/files?per_page=100`), want = full(pr).changed_files;
  if (files.length !== want) return { risk: 'high', hits: [{ file: `(${files.length} of ${want ?? '?'} changed files listed)`, pattern: 'incomplete file list' }] };
  const bump = new Set((HR.version_only || []).filter(f => files.some(x => x.filename === f && x.status === 'modified'))
    .filter(f => versionOnly(f, raw(f, pr.base.sha), raw(f, pr.head.sha))));
  return classifyRisk(files, HR, bump);
}

function label(n) {
  const pr = get(`repos/${R}/pulls/${n}`);
  const { risk, hits } = riskFor(pr);
  const want = risk === 'high' ? C.high_label : C.low_label, drop = risk === 'high' ? C.low_label : C.high_label;
  console.log(`#${n} ${pr.head.sha.slice(0, 8)}: ${want}${hits.length ? '\n  ' + hits.map(h => `${h.file}  (${h.pattern})`).join('\n  ') : ' (no high-risk path changed)'}`);
  if (dry) return;
  send('POST', `repos/${R}/issues/${n}/labels`, { labels: [want] });
  if (pr.labels.some(l => l.name === drop)) gh(['-X', 'DELETE', `repos/${R}/issues/${n}/labels/${encodeURIComponent(drop)}`]);
  return want;
}

const testRun = sha => get(`repos/${R}/commits/${sha}/check-runs?check_name=${encodeURIComponent(C.check)}&filter=latest&per_page=100`).check_runs
  .filter(r => r.app?.slug === 'github-actions').sort((x, y) => (y.started_at || '').localeCompare(x.started_at || ''))[0] || null;

// Everything decide() reads, for the PR's current head. Verdict comments and commit trailers are data; the rules are main's.
function prState(pr, tip) {
  const sha = pr.head.sha;
  const st = get(`repos/${R}/commits/${sha}/status`).statuses.find(s => s.context === C.status) || null;
  const commits = pages(`repos/${R}/pulls/${pr.number}/commits?per_page=100`), want = full(pr).commits;
  if (commits.length !== want) throw new Error(`GitHub listed ${commits.length} of ${want ?? '?'} commits, so the authors are unknown`);
  return {
    risk: riskFor(pr).risk, check: testRun(sha), status: st,
    containsBase: get(`repos/${R}/compare/${tip}...${sha}`).behind_by === 0,
    verdicts: parseVerdicts(pages(`repos/${R}/issues/${pr.number}/comments?per_page=100`)),
    authors: authorsFrom(commits.map(c => c.commit.message), commits.map(c => c.commit.author?.email), C.providers),
  };
}

// The post-merge check (ci.yml on main) failed: open the tip's exact inverse as a PR from the bot. The inverse is built from
// the API, not a checkout: one commit on top of the tip carrying the tip's parent tree. It merges through every rule in
// decide() (test, verdicts for its head, hold window); while main is red it is the only PR that may merge. Returns that PR
// once it exists and is still the exact inverse, else null (merge nothing this run).
function autoRevert(tip) {
  const t8 = tip.slice(0, 8), branch = `auto-revert/${tip.slice(0, 12)}`, marker = `<!-- ${REVERT_MARK}${tip} -->`;
  const tc = get(`repos/${R}/git/commits/${tip}`);
  if (tc.message.includes(REVERT_MARK)) { console.log(`main ${t8}: ${C.check} failed on an auto-revert; not reverting a revert. Escalate to Matt; merging nothing`); return null; }
  const shipped = get(`repos/${R}/commits/${tip}/pulls`).find(p => p.merged_at && p.base.ref === C.base);
  if (!shipped || tc.parents.length !== 1) { console.log(`main ${t8}: ${C.check} failed and the tip is not a squash merge of a PR; revert by hand (gh pr revert <n>); merging nothing`); return null; }
  const want = { sha: tip, parentTree: get(`repos/${R}/git/commits/${tc.parents[0].sha}`).tree.sha };
  const facts = p => { const h = get(`repos/${R}/git/commits/${p.head.sha}`); return { user: p.user?.login, ref: p.head.ref, body: p.body, headParents: h.parents.map(x => x.sha), headTree: h.tree.sha }; };
  const open = get(`repos/${R}/pulls?state=open&base=${C.base}&head=${R.split('/')[0]}:${branch}`)[0];
  if (open) {
    if (!isAutoRevert(facts(open), want)) { console.log(`main ${t8}: #${open.number} on ${branch} is not the bot's exact inverse of ${t8}; escalate to Matt; merging nothing`); return null; }
    if (!open.labels.some(l => [C.low_label, C.high_label].includes(l.name)) && !dry) open.labels = [...open.labels, { name: label(open.number) }];
    if (!testRun(open.head.sha) && !dry) send('POST', `repos/${R}/actions/workflows/ci.yml/dispatches`, { ref: branch });
    console.log(`main ${t8}: ${C.check} failed after #${shipped.number}; only its auto-revert #${open.number} may merge`);
    return open;
  }
  console.log(`main ${t8}: ${C.check} failed after #${shipped.number} merged; ${dry ? 'would open' : 'opening'} its exact inverse from ${branch}`);
  if (dry) return null;
  try { get(`repos/${R}/git/ref/heads/${branch}`); }
  catch {
    const c = JSON.parse(send('POST', `repos/${R}/git/commits`, { message: `Revert #${shipped.number}: post-merge ${C.check} failed on ${C.base}\n\n${marker}`, tree: want.parentTree, parents: [tip] }));
    send('POST', `repos/${R}/git/refs`, { ref: `refs/heads/${branch}`, sha: c.sha });
  }
  let pr;
  try { pr = JSON.parse(send('POST', `repos/${R}/pulls`, { base: C.base, head: branch, title: `Revert #${shipped.number}: post-merge ${C.check} failed (${t8})`, body: `${marker}\nThe post-merge \`${C.check}\` run failed on ${C.base} at ${tip} after #${shipped.number} merged. This PR is its exact inverse, opened by self-merge. It merges like any PR: \`${C.check}\`, verdicts for its head and the hold window.` })); }
  catch (e) { console.log(`FAIL main ${t8}: ${branch} is pushed but GitHub refused the PR (${e.message.split('\n')[0]}). Matt allows GitHub Actions to create pull requests (Settings > Actions > General), or opens ${branch} as a PR by hand.`); process.exitCode = 1; return null; }
  label(pr.number);
  send('POST', `repos/${R}/actions/workflows/ci.yml/dispatches`, { ref: branch });
  console.log(`  opened auto-revert #${pr.number} and dispatched ci.yml on ${branch}; it merges once its rules hold`);
  return null;
}

function merge() {
  // Stop the line: never merge onto a red or untested main, except the red tip's own auto-revert. A GITHUB_TOKEN merge
  // fires no push workflow, so a main tip with no `test` run gets ci.yml dispatched here and is retried on the next run.
  const tip = get(`repos/${R}/commits/${C.base}`).sha;
  const t = testRun(tip);
  if (!t) { console.log(`main ${tip.slice(0, 8)}: no ${C.check} run yet; ${dry ? 'would dispatch' : 'dispatching'} ci.yml, merging nothing this run`); if (!dry) send('POST', `repos/${R}/actions/workflows/ci.yml/dispatches`, { ref: C.base }); return; }
  if (t.status !== 'completed') return console.log(`main ${tip.slice(0, 8)}: ${C.check} still running; merging nothing this run`);
  let prs;
  if (t.conclusion !== 'success') { const rv = autoRevert(tip); if (!rv) return; prs = [rv]; }
  else {
    const only = opt('--pr') || process.env.PR || '';
    prs = (only ? [get(`repos/${R}/pulls/${only}`)] : pages(`repos/${R}/pulls?state=open&base=${C.base}&per_page=100`))
      .filter(p => p.state === 'open').sort((x, y) => x.created_at.localeCompare(y.created_at));
  }
  for (const p of prs) {
    const pr = { number: p.number, base: p.base.ref, draft: p.draft, sameRepo: p.head.repo?.full_name === R, headSha: p.head.sha, labels: p.labels.map(l => l.name) };
    let d;
    try { d = pr.base === C.base && pr.sameRepo ? decide(pr, prState(p, tip), C) : decide(pr, {}, C); } catch (e) { d = { merge: false, reason: `could not read state: ${e.message.split('\n')[0]}` }; }
    console.log(`#${p.number} ${p.head.sha.slice(0, 8)}: ${d.merge ? (dry ? 'WOULD MERGE' : 'MERGE') : 'skip'}: ${d.reason}`);
    if (!d.merge || dry) continue;
    if (get(`repos/${R}/issues/${p.number}/labels`).some(l => l.name === C.hold_label)) { console.log(`#${p.number}: ${C.hold_label} added just now; skip`); continue; }
    try {
      send('PUT', `repos/${R}/pulls/${p.number}/merge`, { merge_method: 'squash', sha: p.head.sha, commit_title: `${p.title} (#${p.number})` });
    } catch (e) { console.log(`#${p.number}: merge refused: ${e.message.split('\n')[0]}`); continue; }
    console.log(`#${p.number}: squash-merged at head ${p.head.sha}. Undo: gh pr revert ${p.number}`);
    // Delete the merged branch (fixed rule 18); GitHub then retargets PRs stacked on it to main.
    try { gh(['-X', 'DELETE', `repos/${R}/git/refs/heads/${p.head.ref}`]); } catch (e) { console.log(`  branch ${p.head.ref} not deleted: ${e.message.split('\n')[0]}`); }
    send('POST', `repos/${R}/actions/workflows/ci.yml/dispatches`, { ref: C.base });
    return console.log(`  dispatched ci.yml on ${C.base} (the post-merge check; a failure opens the auto-revert). One merge per run.`);
  }
}

if (cmd === 'label' && a[0]) label(a[0]);
else if (cmd === 'merge') merge();
else { console.error('usage: pr-gate.mjs label <n> [--dry-run] | merge [--pr <n>] [--dry-run]'); process.exit(1); }
