// The only place eng sync, sync --check, init and pruning change the repo's disk (test/repo-write.test.mjs keeps it so).
// eng manages what is inside the repo only, and does not care how a developer arranges their folders (Core decision
// nd70ke343v7gc0eakdejg7m5f18hx1p9). Each call first applies one rule: every part of the path from the repo root down to
// its parent is a real folder (lstat, never followed) and the entry is no symlink, except a link eng removes, which must
// hold exactly the target eng wrote. A blocked call does nothing, adds one notice line per folder, and never throws.
import fs from 'node:fs';
import path from 'node:path';

// The first part of rel that is not a real folder in root: a symlink, a file, unreadable, or outside the repo; null if none.
// folder: rel itself must be a readable folder when it exists.
export function blocked(root, rel, folder = false) {
  const norm = path.normalize(rel);
  if (path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`)) return { at: rel, why: 'outside' };
  const parts = norm.split(path.sep).filter(p => p && p !== '.');
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/');
    let st; try { st = fs.lstatSync(path.join(root, at)); } catch (e) { return e.code === 'ENOENT' ? null : { at: parts.slice(0, i - 1).join('/') || '.', why: 'unreadable' }; }
    if (st.isSymbolicLink()) return { at, why: 'link' };
    if ((i < parts.length || folder) && !st.isDirectory()) return { at, why: 'file' };
  }
  if (folder) try { fs.readdirSync(path.join(root, rel)); } catch (e) { if (e.code !== 'ENOENT') return { at: rel, why: 'unreadable' }; }
  return null;
}

export const readLink = abs => { try { return fs.readlinkSync(abs); } catch { return null; } };

export function repoWriter(root) {
  const abs = rel => path.join(root, rel), lines = new Map(), notes = [], shown = new Set();
  const why = { link: at => `is a symlink to ${readLink(abs(at))}`, file: () => 'is not a folder', unreadable: () => 'cannot be read', outside: () => 'is outside this repo' };
  // One line per folder eng left alone, with a clause per thing it did not do there.
  const add = (b, clause) => {
    if (!lines.has(b.at)) lines.set(b.at, [`${b.at} ${why[b.why](b.at)}, so eng writes and deletes nothing through it.`]);
    if (clause && !lines.get(b.at).includes(clause)) lines.get(b.at).push(clause);
  };
  const refused = (b, clause) => { add(b, clause); return false; };
  const failed = (e, line) => { if (!e.code) throw e; notes.push(line(e.code)); return false; };
  const parentOf = rel => path.dirname(rel) === '.' ? null : path.dirname(rel);
  const parentBlocked = rel => parentOf(rel) && blocked(root, parentOf(rel), true);
  const mkdirs = rel => { if (parentOf(rel)) fs.mkdirSync(abs(parentOf(rel)), { recursive: true }); };

  return {
    blocked: (rel, folder) => blocked(root, rel, folder),
    add,
    note: line => notes.push(line),
    notices: () => [...[...lines.values()].map(l => l.join(' ')), ...notes],
    // The notices not returned by an earlier fresh(), so init prints what it adds after sync printed its own.
    fresh() { const n = this.notices().filter(l => !shown.has(l)); n.forEach(l => shown.add(l)); return n; },
    // Each folder is checked again after mkdir, just before the write: a single actor, so a swap mid-run is out of scope.
    write(rel, content, { mode } = {}) {
      let b = blocked(root, rel);
      if (b) return refused(b, `eng did not write ${rel}.`);
      try {
        mkdirs(rel);
        if ((b = blocked(root, rel))) return refused(b, `eng did not write ${rel}.`);
        fs.writeFileSync(abs(rel), content);
        if (mode !== undefined) fs.chmodSync(abs(rel), mode);
      } catch (e) { return failed(e, c => `${rel}: eng cannot write it (${c}).`); }
      return true;
    },
    copy(from, rel) {
      const b = blocked(root, rel);
      if (b) return refused(b, `eng did not write ${rel}.`);
      try { mkdirs(rel); fs.copyFileSync(from, abs(rel), fs.constants.COPYFILE_EXCL); } catch (e) { return failed(e, c => `${rel}: eng cannot write it (${c}).`); }
      return true;
    },
    mkdir(rel) {
      const b = blocked(root, rel, true);
      if (b) return refused(b, `eng did not write ${rel}.`);
      try { fs.mkdirSync(abs(rel), { recursive: true }); } catch (e) { return failed(e, c => `${rel}: eng cannot make it (${c}).`); }
      return true;
    },
    // Creates a link only where nothing is: symlinkSync fails on anything there, and eng leaves that.
    symlink(target, rel) {
      const b = parentBlocked(rel);
      if (b) return refused(b, `eng did not link ${rel}.`);
      try { mkdirs(rel); if (parentBlocked(rel)) return refused(parentBlocked(rel), `eng did not link ${rel}.`); fs.symlinkSync(target, abs(rel)); }
      catch (e) { return failed(e, c => c === 'EEXIST' ? `${rel}: something is already there that eng did not make, so eng leaves it.` : `${rel}: eng cannot link it (${c}).`); }
      return true;
    },
    // Removes a link only when it holds exactly the target eng wrote there.
    unlink(rel, target) {
      const b = parentBlocked(rel);
      if (b) return refused(b, `eng did not remove ${rel}.`);
      if (readLink(abs(rel)) !== target) { notes.push(`${rel} is not the link eng made, so eng leaves it.`); return false; }
      try { fs.unlinkSync(abs(rel)); } catch (e) { return failed(e, c => `${rel}: eng cannot remove it (${c}).`); }
      return true;
    },
    // Removes a regular file eng wrote; anything else at rel is left.
    removeFile(rel) {
      const b = blocked(root, rel);
      if (b) return refused(b, `eng did not remove ${rel}.`);
      try { if (!fs.lstatSync(abs(rel)).isFile()) return false; fs.rmSync(abs(rel)); } catch (e) { return failed(e, c => `${rel}: eng cannot remove it (${c}).`); }
      return true;
    },
    removeEmptyDir(rel) {
      if (blocked(root, rel, true)) return false;
      try { if (!fs.lstatSync(abs(rel)).isDirectory() || fs.readdirSync(abs(rel)).length) return false; fs.rmdirSync(abs(rel)); } catch { return false; }
      return true;
    },
  };
}
