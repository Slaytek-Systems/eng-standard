// Self-merge decision for one PR (eng-standard v0.9.1). Pure: live PR state in, { merge, reason } out.
// Merge only when ALL hold: base is main, same-repo branch, not draft, no hold label, a risk label, the head contains
// main's tip, the `test` check is success and the `verdict` status is success on the current head SHA, the verdict
// comments for that exact head pass the tier's rule, and all of it has been green for at least hold_minutes (Matt's
// window to add `hold`). Tier: risk:low needs one independent PASS. risk:high (label or recomputed; gate, auth and
// billing paths are high_risk paths) needs PASSes from two verifiers on two different providers, neither an author's.
export const DEFAULTS = { base: 'main', low_label: 'risk:low', high_label: 'risk:high', hold_label: 'hold', hold_minutes: 120, check: 'test', status: 'verdict' };
export const VERDICT_MARK = '<!-- eng-verdict/v1 -->';
export const REVERT_MARK = 'eng-auto-revert of=';
export const BOT = 'github-actions[bot]';
// Which providers' verdicts count, and which provider each model family runs on: top-level `verifier_providers` in main's
// eng.config.yml (a risk:high path), else this default. A provider not in `trusted` is no provider. Google is not trusted.
export const DEFAULT_VERIFIER_PROVIDERS = {
  trusted: ['openai', 'xai', 'deepseek', 'moonshot', 'zhipu', 'anthropic'],
  families: { gpt: 'openai', openai: 'openai', codex: 'openai', grok: 'xai', xai: 'xai', deepseek: 'deepseek', kimi: 'moonshot', glm: 'zhipu', claude: 'anthropic', anthropic: 'anthropic' },
};
const nonEmpty = x => typeof x === 'string' && x.trim() !== '';
// -> { trusted: Set<provider>, families: Map<lower-case family, provider> }. Maps, so `constructor` or `__proto__` resolves to nothing.
// Only an omitted key falls back to the default; a present but null or malformed one is an error, so a typo cannot widen trust.
export function verifierProviders(cfg) {
  const set = (o, k) => o != null && Object.hasOwn(o, k);
  const vp = set(cfg, 'verifier_providers') ? cfg.verifier_providers : {};
  if (!vp || typeof vp !== 'object' || Array.isArray(vp)) throw new Error('verifier_providers must be a mapping with trusted and families');
  const t = set(vp, 'trusted') ? vp.trusted : DEFAULT_VERIFIER_PROVIDERS.trusted, f = set(vp, 'families') ? vp.families : DEFAULT_VERIFIER_PROVIDERS.families;
  if (!Array.isArray(t) || !t.length || !t.every(nonEmpty)) throw new Error('verifier_providers.trusted must list the providers whose verdicts count');
  if (!f || typeof f !== 'object' || Array.isArray(f) || !Object.values(f).every(nonEmpty)) throw new Error('verifier_providers.families maps a model family to its provider');
  return { trusted: new Set(t), families: new Map(Object.entries(f).map(([k, v]) => [k.toLowerCase(), v])) };
}
const DEFAULT_PROVIDERS = verifierProviders(null);
// Own-property lookups only: `constructor`, `__proto__` or `toString` must not resolve through Object.prototype.
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const trustedProvider = (p, P) => (typeof p === 'string' && P.trusted.has(p) ? p : null);
const familyOf = (f, P) => P.families.get(String(f).toLowerCase()) ?? null;
const PASSING = new Set(['PASS', 'PASS+NOTES']);
// GitHub's author_association values for people with write access. The repo is public: anyone else can comment.
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function selfMergeConfig(cfg) {
  const s = cfg?.ship?.self_merge || {}, h = cfg?.ship?.high_risk || {};
  const c = { ...DEFAULTS, ...s, high_label: h.label || DEFAULTS.high_label, low_label: h.low_label || DEFAULTS.low_label };
  if (!(Number.isFinite(c.hold_minutes) && c.hold_minutes >= 0)) throw new Error(`ship.self_merge.hold_minutes must be a number >= 0 (got ${JSON.stringify(s.hold_minutes)})`);
  const providers = verifierProviders(cfg), vl = c.verifier_logins ?? null;
  if (vl !== null && (typeof vl !== 'object' || Array.isArray(vl) || !Object.keys(vl).length || Object.values(vl).some(p => !providers.trusted.has(p))))
    throw new Error(`ship.self_merge.verifier_logins maps a GitHub login to a trusted provider (${[...providers.trusted].join(', ')})`);
  return { ...c, verifier_logins: vl, providers };
}

// Verdicts live in PR comments (from PR #20): `eng verdict ... --pr <n>` posts one per record, with the head SHA and provider.
export const verdictBody = rec => `${VERDICT_MARK}\n**eng verdict: ${rec.result}** by \`${rec.by}\` (${rec.family}${rec.provider ? `, ${rec.provider}` : ''}) for head \`${String(rec.sha).slice(0, 8)}\`, patch-id \`${String(rec.patch_id).slice(0, 12)}\`${rec.evidence ? `. Evidence: ${rec.evidence}` : ''}\n\n\`\`\`json\n${JSON.stringify(rec)}\n\`\`\``;
export function parseVerdicts(comments) {
  const out = [];
  for (const c of comments || []) {
    if (!String(c.body || '').startsWith(VERDICT_MARK)) continue;
    const m = c.body.match(/```json\n([\s\S]+?)\n```/); if (!m) continue;
    let v; try { v = JSON.parse(m[1]); } catch { continue; }
    // An edited comment counts from its edit: it orders as the verifier's latest and restarts the hold window.
    const t = [c.created_at, c.updated_at].map(Date.parse).filter(Number.isFinite);
    if (v && v.sha && v.result && v.by && v.family) out.push({ ...v, login: c.user?.login ?? null, association: c.author_association ?? null, comment_at: t.length ? new Date(Math.max(...t)).toISOString() : null });
  }
  return out.sort((x, y) => (Date.parse(x.comment_at || x.at) || 0) - (Date.parse(y.comment_at || y.at) || 0));
}
// A declared provider must be a trusted one and must not contradict the declared family's; otherwise it is no provider.
const providerOf = (v, P) => {
  const f = familyOf(v.family, P);
  if (v.provider && f && v.provider !== f) return null;
  return trustedProvider(v.provider || f, P);
};

// Main-owned trust policy, applied before any verdict counts or supersedes another. Only comments by someone with write
// access (OWNER, MEMBER, COLLABORATOR) count. With verifier_logins (login -> provider, main's eng.config.yml) only those
// logins count, the provider is the login's, and each login is one verifier. Without it, verifiers share the owner's
// account, so `by` names the verifier and the provider is self-declared (the documented residual). Either way only a
// provider in verifier_providers.trusted counts.
export function trusted(verdicts, logins, P = DEFAULT_PROVIDERS) {
  const ok = verdicts.filter(v => TRUSTED_ASSOCIATIONS.has(v.association));
  if (!logins) return ok.map(v => ({ ...v, key: v.by, provider: providerOf(v, P) }));
  return ok.filter(v => typeof v.login === 'string' && trustedProvider(own(logins, v.login), P)).map(v => ({ ...v, key: v.login, provider: own(logins, v.login) }));
}

// Commit messages -> who wrote the patch (Agent / Agent-Family trailers, and the providers those families run on).
export function authorsFrom(messages, emails = [], P = DEFAULT_PROVIDERS) {
  const ids = new Set(emails.filter(Boolean)), fams = new Set();
  for (const msg of messages) for (const l of String(msg).split('\n')) {
    const m = l.match(/^(Agent|Agent-Family):\s*(.+)$/); if (!m) continue;
    for (const x of m[2].split(',').map(s => s.trim()).filter(Boolean)) (m[1] === 'Agent' ? ids : fams).add(x);
  }
  return { ids, fams, providers: new Set([...fams].map(f => familyOf(f, P)).filter(Boolean)) };
}

// verdicts: trusted(parseVerdicts(...)) for this PR. Only verdicts for the exact head count. Each verifier's latest one
// counts, and any FAIL among them blocks: another verifier's PASS cannot outvote it.
export function verdictGate(verdicts, authors, headSha, high) {
  const h8 = headSha.slice(0, 8);
  const mine = verdicts.filter(v => !authors.ids.has(v.by) && !authors.fams.has(v.family));
  const forHead = mine.filter(v => v.sha === headSha);
  if (!forHead.length) {
    const stale = mine.filter(v => v.sha !== headSha).map(v => v.sha.slice(0, 8));
    return { ok: false, reason: stale.length ? `stale verdicts (for ${[...new Set(stale)].join(', ')}), none for head ${h8}` : `no independent verdict comment for head ${h8}` };
  }
  const latest = [...new Map(forHead.map(v => [v.key, v])).values()];
  const failed = latest.find(v => !PASSING.has(v.result));
  if (failed) return { ok: false, reason: `verdict ${failed.result} by ${failed.by} on head ${h8} (its latest)` };
  const at = Math.max(...latest.map(v => Date.parse(v.comment_at || v.at) || 0));
  if (!high) return { ok: true, at, reason: `PASS by ${latest.map(v => v.by).join(', ')}` };
  const providers = new Set(latest.map(v => v.provider).filter(p => p && !authors.providers.has(p)));
  if (providers.size < 2) return { ok: false, reason: `risk:high needs PASSes on head ${h8} from two providers other than the authors' (${[...authors.providers].join(', ') || 'none declared'}); have ${[...providers].join(', ') || 'none'}` };
  return { ok: true, at, reason: `PASS from ${[...providers].join(' + ')}` };
}

// An auto-revert the controller opened for main's red tip: opened by the bot, on auto-revert/<sha12>, one commit whose
// parent is the tip and whose tree is the tip's parent tree, so it is the tip's exact inverse.
// rv: { user, ref, body, headParents, headTree }   tip: { sha, parentTree }
export function isAutoRevert(rv, tip) {
  return rv.user === BOT && rv.ref === `auto-revert/${tip.sha.slice(0, 12)}` && String(rv.body || '').includes(`${REVERT_MARK}${tip.sha}`)
    && rv.headParents?.length === 1 && rv.headParents[0] === tip.sha && rv.headTree === tip.parentTree;
}

// pr: { number, base, draft, sameRepo, headSha, labels: [names] }
// state: { risk: 'low'|'high', containsBase, check: { head_sha, status, conclusion, completed_at } | null,
//          status: { state, created_at } | null, verdicts: parseVerdicts(...), authors: authorsFrom(...) }  (for pr.headSha)
// decide() applies trusted() itself, so no caller can count an untrusted comment.
export function decide(pr, state, c, now = Date.now()) {
  const no = reason => ({ merge: false, reason });
  if (pr.base !== c.base) return no(`base is ${pr.base}, not ${c.base}`);
  if (!pr.sameRepo) return no('head branch is in a fork');
  if (pr.draft) return no('draft');
  if (pr.labels.includes(c.hold_label)) return no(`${c.hold_label} label`);
  if (!pr.labels.includes(c.low_label) && !pr.labels.includes(c.high_label)) return no(`no ${c.low_label} or ${c.high_label} label`);
  const high = pr.labels.includes(c.high_label) || state.risk !== 'low';
  if (state.containsBase !== true) return no(`head ${pr.headSha.slice(0, 8)} does not contain ${c.base}'s tip: update the branch, then re-verify the new head`);
  const k = state.check;
  if (!k || k.head_sha !== pr.headSha) return no(`no ${c.check} check on head ${pr.headSha.slice(0, 8)}`);
  if (k.status !== 'completed' || k.conclusion !== 'success') return no(`${c.check} is ${k.conclusion || k.status} on head`);
  const v = state.status;
  if (!v) return no(`no ${c.status} status on head ${pr.headSha.slice(0, 8)}`);
  if (v.state !== 'success') return no(`${c.status} is ${v.state} on head`);
  const g = verdictGate(trusted(state.verdicts || [], c.verifier_logins, c.providers ?? DEFAULT_PROVIDERS), state.authors, pr.headSha, high);
  if (!g.ok) return no(g.reason);
  const readyAt = Math.max(Date.parse(k.completed_at), Date.parse(v.created_at), g.at);
  if (!Number.isFinite(readyAt)) return no('cannot read when the checks went green');
  const due = readyAt + c.hold_minutes * 60_000;
  if (now < due) return { merge: false, reason: `hold window: green since ${new Date(readyAt).toISOString()}, merges after ${new Date(due).toISOString()} unless labelled ${c.hold_label}`, due };
  return { merge: true, reason: `${high ? c.high_label : c.low_label}: ${g.reason}; all green on ${pr.headSha.slice(0, 8)} for ${Math.floor((now - readyAt) / 60_000)} min (window ${c.hold_minutes})` };
}
