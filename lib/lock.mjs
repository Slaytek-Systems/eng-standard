// .eng/lock.json: the standard version and the sorted paths eng sync manages. It holds no content hashes, so a repo-owned
// edit to a managed file never changes the lock, and two branches that each edit one do not conflict in it.
import path from 'node:path';

// Never advise deleting the lock: a sync from no lock stops managing every file the repo edited, such as its PR template.
const RESTORE = 'Fix: restore .eng/lock.json from git (git checkout -- .eng/lock.json)';
const ENTRY_FIX = 'Fix: correct each refused entry in .eng/lock.json as shown, or remove it when it names no repo file, and leave the other entries as they are';

// The repo path a refused entry most likely means, or null: ./x, x//y and x/ name x and x/y, and /x names x.
function entryFix(f, why) {
  if (why !== 'not normalised' && !(why === 'absolute' && f.startsWith('/'))) return null;
  const n = path.posix.normalize(f.replace(/^\/+/, '')).replace(/\/+$/, '');
  return lockPathProblem(n) ? null : n;
}

// Why a lock entry is not a path eng sync may write or delete, or null. eng sync deletes the entries it no longer renders,
// so an entry must be a relative, normalised path inside the work tree: no absolute path, no `..`, nothing in .git.
export function lockPathProblem(f) {
  if (typeof f !== 'string') return 'not a string';
  if (f === '') return 'empty';
  if (f.includes('\0')) return 'contains a NUL byte';
  if (f.includes('\\')) return 'contains a backslash';
  if (path.posix.isAbsolute(f) || /^[A-Za-z]:/.test(f)) return 'absolute';
  const parts = f.split('/');
  if (parts.includes('..')) return 'leaves the repo (..)';
  if (path.posix.normalize(f) !== f || parts.includes('.') || f.endsWith('/')) return 'not normalised';
  if (parts[0].toLowerCase() === '.git') return 'inside .git';
  return null;
}

// Throws on a lock eng must not act on, before any caller writes or deletes. No lock (text null) is an empty one; an empty
// file is not.
export function parseLock(text) {
  if (text === null) return { package: null, files: [] };
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`.eng/lock.json: not valid JSON (${e.message}). ${RESTORE}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`.eng/lock.json: not a JSON object. ${RESTORE}`);
  // Up to 0.17.1 the lock also listed the .claude/skills links eng made; that field is ignored and the next eng sync drops it.
  // Up to 0.11.0 files was { path: sha256 } beside a config_hash; its keys are the paths, and the next eng sync rewrites it.
  const legacy = raw.files !== null && typeof raw.files === 'object' && !Array.isArray(raw.files) && Object.values(raw.files).every(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
  const files = Array.isArray(raw.files) ? raw.files : legacy ? Object.keys(raw.files) : null;
  if (!files) throw new Error(`.eng/lock.json: files must be a list of repo paths (or the 0.11.0 { path: sha256 } object), not ${JSON.stringify(raw.files ?? null)}. ${RESTORE}`);
  const bad = files.map(f => [f, lockPathProblem(f)]).filter(([, why]) => why);
  if (bad.length) throw new Error(`.eng/lock.json: files lists ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that eng sync must not write or delete: ${bad.map(([f, why]) => { const n = entryFix(f, why); return `${JSON.stringify(f)} (${why}${!n ? '' : why === 'absolute' ? `; if it means the repo file ${JSON.stringify(n)}, write that` : `; write ${JSON.stringify(n)}`})`; }).join(', ')}. ${ENTRY_FIX}`);
  return { package: raw.package ?? null, files: [...files].sort() };
}

export const lockText = (version, files) => JSON.stringify({ package: version, files: [...files].sort() }, null, 2) + '\n';
