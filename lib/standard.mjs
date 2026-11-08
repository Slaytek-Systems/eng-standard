// The standard's own lifecycle: how a repo pins it, whether the pin and the rendered files are current, and what changed
// since. Pure: callers pass file contents in. docs/lifecycle.md is the human guide.
const parts = v => String(v).replace(/^v/, '').split('.').map(Number);
const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

export const PKG_NAME = '@slayteksystems/eng-standard';
export const REPO_URL = 'https://github.com/Slaytek-Systems/eng-standard';
export const RAW_MAIN = 'https://raw.githubusercontent.com/Slaytek-Systems/eng-standard/main/';
export const LIFECYCLE_DOC = 'docs/lifecycle.md';

// A pin is immutable when it names a full commit SHA, a vX.Y.Z tag, an exact version or a local path. Anything else moves
// under the repo with no commit in it.
export function pinStatus(spec) {
  const s = String(spec).trim(), hash = s.includes('#') ? s.slice(s.lastIndexOf('#') + 1) : null;
  if (hash !== null) {
    if (/^[0-9a-f]{40}$/.test(hash) || /^v\d+\.\d+\.\d+$/.test(hash)) return { ok: true };
    return { ok: false, why: `#${hash} is a branch, short SHA or range, so it moves without a commit in this repo` };
  }
  if (/^(file:|link:|workspace:)/.test(s) || /^\d+\.\d+\.\d+$/.test(s)) return { ok: true };
  return { ok: false, why: `${s} has no fixed ref (a range, a dist-tag, or a git URL with no #<tag or sha>)` };
}

// The pin a repo declares in its package.json text, or null (no package.json, not declared, or eng-standard itself).
export function declaredPin(pkgJsonText) {
  let pj; try { pj = JSON.parse(pkgJsonText); } catch { return null; }
  if (!pj || pj.name === PKG_NAME) return null;
  for (const k of ['devDependencies', 'dependencies', 'optionalDependencies']) if (pj[k]?.[PKG_NAME] != null) return { field: k, spec: pj[k][PKG_NAME] };
  return null;
}

// What eng sync --check and eng doctor fail about the standard itself. Each line names its fix.
export function lifecycleProblems({ lockVersion, installed, pin }) {
  const out = [];
  // No version means nobody knows what rendered the files, so it fails like a stale one rather than passing.
  if (typeof lockVersion !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(lockVersion)) out.push(`.eng/lock.json: no valid renderer version (package is ${JSON.stringify(lockVersion ?? null)}), so what rendered these files is unknown. Fix: run eng sync and commit what it writes (${LIFECYCLE_DOC}, Upgrade)`);
  else if (lockVersion !== installed) out.push(`.eng/lock.json: rendered by eng-standard ${lockVersion}, installed is ${installed}. Fix: run eng sync and commit what it writes (${LIFECYCLE_DOC}, Upgrade)`);
  const p = pin && pinStatus(pin.spec);
  if (p && !p.ok) out.push(`package.json ${pin.field}.${PKG_NAME}: ${p.why}. Fix: pin a release tag (github:Slaytek-Systems/eng-standard#vX.Y.Z) or a full commit SHA (${LIFECYCLE_DOC}, Pin)`);
  return out;
}

// CHANGELOG.md headings newer than `from`, newest first. Unreleased headings above the `from` entry count too.
export function changesSince(changelog, from) {
  const heads = [...String(changelog).matchAll(/^## (.+)$/gm)].map(m => m[1].trim());
  const i = heads.findIndex(h => h.split(/\s/)[0] === from);
  return i >= 0 ? heads.slice(0, i) : heads.filter(h => /^\d+\.\d+\.\d+\b/.test(h) && cmp(h.split(/\s/)[0], from) > 0);
}
export const isBehind = (installed, latest) => cmp(installed, latest) < 0;

// The "This standard" section of the rendered AGENTS.md block: how an agent in any repo learns the standard's own rules.
export function standardText(rewriteRule) {
  return `### This standard (eng-standard)
- **What it is.** ${REPO_URL}: one \`eng.config.yml\` renders this block, \`SHIPPING.md\`, \`STACK.md\`, the hooks and the skills. \`.eng/lock.json\` lists what it manages and \`package\` is the version that rendered it. Never hand-edit a generated file; edit the config and run \`eng sync\`.
- **Keep it current.** \`eng sync --check\` (pre-commit and CI) fails when a generated file drifts from the config, when \`.eng/lock.json\` was rendered by another eng version than the installed one or names no version, and when the package.json pin of \`${PKG_NAME}\` floats (a branch, short SHA, range or bare git URL). Pin a release tag (\`#vX.Y.Z\`, CI tags every release) or a full commit SHA.
- **Upgrade.** \`eng doctor\` prints the installed, rendered and latest versions and the CHANGELOG entries in between. Move the pin to the new tag, install, run \`eng sync\`, run \`eng gate\`, and commit everything in one PR.
- **Set up or remove.** \`eng init\` sets up any repo (one contextual init). To remove the standard, follow the Uninstall steps in the guide.
- **Joining agent.** Read this block, then \`SHIPPING.md\`. Put \`Agent:\` and \`Agent-Family:\` trailers on every commit. Run \`eng gate\` before asking for review, and never merge your own PR. ${rewriteRule}
- **Guide.** \`${LIFECYCLE_DOC}\` in the package (\`node_modules/${PKG_NAME}/${LIFECYCLE_DOC}\`) or ${REPO_URL}/blob/main/${LIFECYCLE_DOC}. A problem with the standard itself is fixed upstream in eng-standard, never by patching generated files here.`;
}
