// The standard's own lifecycle: where it comes from, how a repo pins it, whether the pin and the rendered files are
// current, and what changed since. Pure: callers pass file contents in. docs/lifecycle.md is the human view.
const parts = v => String(v).replace(/^v/, '').split('.').map(Number);
const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

export const REPO = 'Slaytek-Systems/eng-standard';
export const PKG_NAME = '@slayteksystems/eng-standard';
export const REPO_URL = `https://github.com/${REPO}`;
export const RAW_MAIN = `https://raw.githubusercontent.com/${REPO}/main/`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const LIFECYCLE_DOC = 'docs/lifecycle.md';

// A pin is immutable when it names a commit SHA, a vX.Y.Z tag or an exact version. Anything else moves under the repo.
export function pinStatus(spec) {
  if (spec == null) return { kind: 'missing', ok: false };
  const s = String(spec).trim();
  const hash = s.includes('#') ? s.slice(s.lastIndexOf('#') + 1) : null;
  const moved = /Mattslayga\/eng-standard/i.test(s) ? { moved: `the repo moved to ${REPO} (24 Oct 2026); GitHub redirects, but point the pin at the new name on the next upgrade` } : {};
  if (hash !== null) {
    if (/^[0-9a-f]{40}$/.test(hash)) return { kind: 'sha', ref: hash, ok: true, ...moved };
    if (/^v\d+\.\d+\.\d+$/.test(hash)) return { kind: 'tag', ref: hash, ok: true, ...moved };
    return { kind: 'floating', ref: hash, ok: false, why: `#${hash} is a branch, short SHA or range; it moves without a commit in this repo` };
  }
  if (/^(file:|link:|workspace:)/.test(s)) return { kind: 'local', ref: s, ok: true };
  if (/^\d+\.\d+\.\d+$/.test(s)) return { kind: 'semver', ref: s, ok: true };
  return { kind: 'floating', ref: s, ok: false, why: `${s} has no fixed ref (a range, a tag like latest, or a git URL with no #<sha>)` };
}

// The pin a repo declares, from its package.json text. null when the repo has no package.json or does not declare it.
export function declaredPin(pkgJsonText) {
  if (!pkgJsonText) return null;
  let pj; try { pj = JSON.parse(pkgJsonText); } catch { return null; }
  if (pj.name === PKG_NAME) return null;
  for (const k of ['devDependencies', 'dependencies', 'optionalDependencies']) if (pj[k]?.[PKG_NAME] != null) return { field: k, spec: pj[k][PKG_NAME] };
  return null;
}

// Problems drift-check reports about the standard itself: rendered by another version, or a pin that floats.
export function lifecycleProblems({ lockVersion, installed, pin }) {
  const out = [];
  if (lockVersion !== installed) out.push(`.eng/lock.json: rendered by eng-standard ${lockVersion ?? '(unknown)'}, installed is ${installed}. Run eng sync and commit what it writes (${LIFECYCLE_DOC}, Upgrade)`);
  if (pin) { const p = pinStatus(pin.spec); if (!p.ok) out.push(`package.json ${pin.field}.${PKG_NAME}: ${p.why}. Pin a commit SHA or a vX.Y.Z tag (${LIFECYCLE_DOC}, Pin)`); }
  return out;
}

// CHANGELOG.md sections, newest first: { title, version (null for Unreleased), body }.
export function changelogSections(text) {
  const out = []; let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^## (.+)$/.exec(line);
    if (m) { cur = { title: m[1].trim(), version: (/^(\d+\.\d+\.\d+)\b/.exec(m[1].trim()) || [])[1] ?? null, body: [] }; out.push(cur); }
    else if (cur) cur.body.push(line);
  }
  return out.map(s => ({ ...s, body: s.body.join('\n').trim() }));
}

// What an upgrade from `from` to the newest entry brings: every section above the `from` entry.
export function sectionsSince(text, from) {
  const all = changelogSections(text), i = all.findIndex(s => s.version === from);
  return i < 0 ? all.filter(s => s.version && cmp(s.version, from) > 0) : all.slice(0, i);
}

// upgrade-check's verdict. behind and stale are the two ways a repo is out of date; floating is a pin problem.
export function upgradeReport({ installed, lockVersion, latest, pin, changelog }) {
  const behind = latest && cmp(installed, latest) < 0, stale = lockVersion !== installed;
  const p = pin ? pinStatus(pin.spec) : null;
  return { installed, rendered: lockVersion ?? null, latest, behind: !!behind, stale, pin: p, since: behind ? sectionsSince(changelog, installed).map(s => s.title) : [],
    ok: !behind && !stale && (!p || p.ok) };
}

// The "This standard" section of the rendered AGENTS.md block: how an agent in any repo finds the standard's own rules.
export function standardText() {
  return `### This standard (eng-standard)
- **Source and version.** ${REPO_URL}. The version that rendered these files is \`package\` in \`.eng/lock.json\`. The repo pins \`${PKG_NAME}\` in package.json at a commit SHA or a \`vX.Y.Z\` tag, never a branch or range; \`eng drift-check\` fails a floating pin and a lock rendered by another version.
- **Upgrade.** \`eng upgrade-check\` prints the installed, rendered and latest versions and the CHANGELOG entries in between. Move the pin, install, run \`eng sync\`, and commit everything it writes in one PR. Full guide: \`${LIFECYCLE_DOC}\` in the package (\`node_modules/${PKG_NAME}/${LIFECYCLE_DOC}\`), or ${REPO_URL}/blob/main/${LIFECYCLE_DOC}.
- **Change a rule here.** Edit \`eng.config.yml\`, run \`eng sync\`. Never hand-edit a generated file (\`eng drift-check\` fails). Recorded exceptions only: \`stack.exceptions\`, \`renovation.divergences\`, reviewed baselines, \`agents.rules\` with \`enforced_by: review\` and a why (${LIFECYCLE_DOC}, Exceptions).
- **New repo:** \`eng init\` (starter pack). **Existing repo:** \`eng renovate audit\`, then \`eng renovate plan\` (renovation pack). **Remove:** \`eng uninstall\` (dry run; \`--apply\` acts).
- **Problem with the standard itself** (a wrong rule, a broken command, a doc that disagrees with the code): open an issue at ${ISSUES_URL} with the repo, the eng version and the command output. Fix it upstream in eng-standard, never by patching generated files here.`;
}
