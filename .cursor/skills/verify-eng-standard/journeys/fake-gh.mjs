#!/usr/bin/env node
// A stand-in for `gh` that serves one fake GitHub repo from the JSON file $GH_STATE, so the self-merge journey never calls
// GitHub. It answers the reads that eng and scripts/pr-gate.mjs make, records the comments and commit statuses eng posts
// (as the account $FAKE_GH_LOGIN), logs every call to state.calls, and refuses anything else with exit 1.
// State: { main, behind, pulls: { <n>: pull }, files: { <n>: [file] }, checks: { <sha>: conclusion },
//          statuses: { <sha>: [row, oldest first] }, comments: { <n>: [comment] }, calls: [] }
import fs from 'node:fs';

const file = process.env.GH_STATE, login = process.env.FAKE_GH_LOGIN || 'Mattslayga';
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
st.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const out = v => { save(); process.stdout.write(JSON.stringify(v)); process.exit(0); };
const refuse = why => { save(); process.stderr.write(`fake gh: ${why}: gh ${args.join(' ')}\n`); process.exit(1); };
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

if (args[0] === 'pr' && args[1] === 'view') {
  const p = st.pulls[args[2]];
  if (!p) refuse('no such PR');
  out({ headRefOid: p.head.sha, state: p.state.toUpperCase() });
}
if (args[0] !== 'api') refuse('not served');

let method = 'GET', slurp = false, input = false, route = null;
const fields = {};
for (let i = 1; i < args.length; i++) {
  const x = args[i];
  if (x === '-X') method = args[++i];
  else if (x === '--paginate') continue;
  else if (x === '--slurp') slurp = true;
  else if (x === '--input') { input = true; i++; }
  else if (x === '-f' || x === '-F') { const [k, ...v] = args[++i].split('='); fields[k] = v.join('='); if (method === 'GET') method = 'POST'; }
  else if (x === '-H') refuse('raw content not served');
  else route = x;
}
if (input) refuse('writes with --input are not served');
const path = route.replace(/^repos\/[^/]+\/[^/]+\//, '').replace(/\?.*$/, '');
const list = v => out(slurp ? [v] : v);
let m;
if (method === 'GET') {
  if (path === 'commits/main') out({ sha: st.main });
  if ((m = path.match(/^commits\/(\w+)\/check-runs$/))) out({ check_runs: st.checks[m[1]] ? [{ app: { slug: 'github-actions' }, status: 'completed', conclusion: st.checks[m[1]], started_at: '2026-11-15T00:00:00Z', head_sha: m[1] }] : [] });
  if ((m = path.match(/^pulls\/(\d+)$/)) && st.pulls[m[1]]) out(st.pulls[m[1]]);
  if ((m = path.match(/^pulls\/(\d+)\/files$/))) list(st.files[m[1]] ?? []);
  if ((m = path.match(/^commits\/(\w+)\/statuses$/))) list([...(st.statuses[m[1]] ?? [])].reverse());
  if ((m = path.match(/^compare\/\w+\.\.\.(\w+)$/))) out({ behind_by: st.behind ?? 0 });
  if ((m = path.match(/^issues\/(\d+)\/comments$/))) list(st.comments[m[1]] ?? []);
}
if (method === 'POST') {
  if ((m = path.match(/^issues\/(\d+)\/comments$/)) && fields.body) {
    const c = { id: Date.now(), body: fields.body, user: { login }, author_association: login === 'Mattslayga' ? 'OWNER' : 'COLLABORATOR', created_at: now(), updated_at: now() };
    (st.comments[m[1]] ??= []).push(c); out(c);
  }
  if ((m = path.match(/^statuses\/(\w+)$/)) && fields.state && fields.context) {
    const rows = st.statuses[m[1]] ??= [];
    const s = { id: st.nextStatus = (st.nextStatus ?? 0) + 1, state: fields.state, context: fields.context, description: fields.description ?? '', creator: { login }, created_at: now(), updated_at: now() };
    rows.push(s); out(s);
  }
}
refuse(`${method} ${path} not served`);
