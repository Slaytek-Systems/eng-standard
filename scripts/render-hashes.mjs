#!/usr/bin/env node
// Renders each config with one eng package and prints {fixture: {path: sha256}} for every file eng sync wrote.
// The byte-identity proof for profile: slaytek (test/profile.test.mjs) runs it twice: the v0.17.2 package on the
// configs as they are, and this package with `--append 'profile: slaytek'`, then compares the two maps. A config eng sync
// refuses records which keys it named instead (the template default it quotes may change), so it must stay refused alike.
//   node scripts/render-hashes.mjs [--pkg <eng package dir>] [--append <config line>] <config.yml>...
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i < 0 ? null : args.splice(i, 2)[1]; };
const pkg = path.resolve(opt('--pkg') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const append = opt('--append');
const tmp = fs.mkdtempSync(path.join(process.env.ENG_TMP || os.tmpdir(), 'render-hashes-'));
const out = {};
try {
  for (const cfg of args) {
    const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
    execFileSync('git', ['init', '-q', dir]);
    let text = fs.readFileSync(cfg, 'utf8');
    if (append) text = `${text}${text.endsWith('\n') ? '' : '\n'}${append}\n`;
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), text);
    try { execFileSync(process.execPath, [path.join(pkg, 'bin/eng.mjs'), 'sync'], { cwd: dir, stdio: 'pipe' }); }
    catch (e) { out[path.basename(cfg)] = { refused: String(e.stderr).split('\n').slice(1).map(l => l.trim().split(':')[0]).filter(Boolean) }; continue; }
    const files = {};
    const walk = rel => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = path.posix.join(rel, e.name);
        if (r === '.git' || r === 'eng.config.yml') continue;
        if (e.isDirectory()) { walk(r); continue; }
        let body = fs.readFileSync(path.join(dir, r));
        if (r === '.eng/lock.json') body = Buffer.from(String(body).replace(/"package": "[^"]*"/, '"package": "<version>"'));
        files[r] = crypto.createHash('sha256').update(body).digest('hex');
      }
    };
    walk('');
    out[path.basename(cfg)] = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
