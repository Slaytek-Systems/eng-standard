// .eng/lock.json: the standard version and the sorted paths eng sync manages. It holds no content hashes, so a repo-owned
// edit to a managed file never changes the lock, and two branches that each edit one do not conflict in it.
export function parseLock(text) {
  const raw = text ? JSON.parse(text) : {};
  // Up to 0.17.1 the lock also listed the .claude/skills links eng made; that field is ignored and the next eng sync drops it.
  // Up to 0.11.0 files was { path: sha256 } beside a config_hash. Read until 0.13.0; the next eng sync rewrites it.
  const files = Array.isArray(raw.files) ? raw.files : Object.keys(raw.files || {});
  return { package: raw.package ?? null, files: [...files].sort() };
}

export const lockText = (version, files) => JSON.stringify({ package: version, files: [...files].sort() }, null, 2) + '\n';
