// .eng/lock.json: the standard version and the sorted paths eng sync manages. It holds no content hashes, so a repo-owned
// edit to a managed file never changes the lock, and two branches that each edit one do not conflict in it.

// Why a lock entry is not a relative repo file path, or null. eng sync deletes the entries it no longer renders, so an entry
// that is absolute, leaves the repo or names a file in any .git folder must never reach it.
export function lockPathProblem(f) {
  if (typeof f !== 'string') return 'not a string';
  if (f === '') return 'empty';
  if (f.includes('\0')) return 'has a NUL byte';
  if (f.includes('\\')) return 'has a backslash';
  if (f.startsWith('/') || /^[A-Za-z]:/.test(f)) return 'absolute';
  const parts = f.split('/');
  if (parts.includes('')) return 'has an empty segment or a trailing slash';
  if (parts.some(s => s === '.' || s === '..')) return 'has a . or .. segment';
  if (parts.some(s => s.toLowerCase() === '.git')) return 'has a .git segment';
  return null;
}

// Throws a fixed message for a lock eng must not act on; callers read the lock before they write or delete anything.
// No lock (text null) is an empty one.
export function parseLock(text) {
  if (text === null || text === undefined) return { package: null, files: [] };
  const fix = 'Fix: correct .eng/lock.json, then run eng sync.';
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error(`.eng/lock.json: not valid JSON. ${fix}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`.eng/lock.json: not a JSON object. ${fix}`);
  // Up to 0.17.1 the lock also listed the .claude/skills links eng made; that field is ignored and the next eng sync drops it.
  // Up to 0.11.0 files was { path: sha256 } beside a config_hash; its keys are the paths, and the next eng sync rewrites it.
  const legacy = raw.files !== null && typeof raw.files === 'object' && !Array.isArray(raw.files) && Object.values(raw.files).every(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
  const files = Array.isArray(raw.files) ? raw.files : legacy ? Object.keys(raw.files) : null;
  if (!files) throw new Error(`.eng/lock.json: files must be a list of repo file paths. ${fix}`);
  const bad = files.map(f => [f, lockPathProblem(f)]).filter(([, why]) => why);
  if (bad.length) throw new Error(`.eng/lock.json: files lists ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that ${bad.length === 1 ? 'is not a relative repo file path' : 'are not relative repo file paths'}: ${bad.map(([f, why]) => `${JSON.stringify(f)} (${why})`).join(', ')}. Fix: correct each refused entry in .eng/lock.json, then run eng sync.`);
  return { package: raw.package ?? null, files: [...files].sort() };
}

export const lockText = (version, files) => JSON.stringify({ package: version, files: [...files].sort() }, null, 2) + '\n';
