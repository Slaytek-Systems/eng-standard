// Release tags (Matt, 3 Nov 2026). A release is the main commit that changed package.json's version. Once that commit's
// ci run is green, scripts/release-tag.mjs tags it vX.Y.Z. A tag is created once and never moved or deleted. Pure.
const SEMVER = /^\d+\.\d+\.\d+$/;
const parts = v => v.split('.').map(Number);
const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// version: package.json at the commit; prev: at its first parent (null when there is none); tagSha: the commit the tag
// vX.Y.Z already names, or null. Returns { action: create | exists | skip | error, tag, why }.
export function releaseTag({ version, prev, sha, tagSha }) {
  const tag = `v${version}`;
  if (!SEMVER.test(String(version))) return { action: 'error', tag, why: `package.json version ${version} is not X.Y.Z` };
  if (tagSha) return tagSha === sha ? { action: 'exists', tag, why: `${tag} already names ${sha.slice(0, 12)}` }
    : { action: 'skip', tag, why: `${tag} already names ${tagSha.slice(0, 12)}; a tag is never moved` };
  if (prev === version) return { action: 'skip', tag, why: `not a release commit: version is still ${version}` };
  if (prev && SEMVER.test(prev) && cmp(version, prev) < 0) return { action: 'skip', tag, why: `version went back from ${prev} to ${version} (a revert); no tag, and ${`v${prev}`} stays` };
  return { action: 'create', tag, why: `release commit: ${prev ?? 'none'} -> ${version}` };
}
