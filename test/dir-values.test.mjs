// Piece B-values (Core task p576xqexf3yb2xmgmzx3hh6fq58jnwgx): a config *_dir value builds repo paths and is rendered
// into the AGENTS.md block, so config validation refuses it, before any write, unless it is a normalised relative repo
// path with no <!--.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { dirValueErrors } from '../lib/verification.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const out = r => r.stdout + r.stderr;
const scratch = [];
after(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

const bad = repo => ['', ' ', '/.eng/x', './.eng/x', `../${repo}/.eng/x`, '.eng/../x', '.eng/./x', '.eng//x', '.eng/x/', '.eng\\x', '.eng/x\0', '.eng/<!--x', '<!-- eng:end -->'];
const good = ['.eng/checks', '.agents/skills', 'tools/skills', 'ci/checks', 'my dir/x', '.x'];

test('dirValueErrors refuses every *_dir value that is not a normalised relative repo path, or that holds <!--', () => {
  for (const key of ['verification.checks_dir', 'agents.skills_dir', 'e2e.evidence_dir', 'fallow.baselines_dir']) {
    const [a, b] = key.split('.');
    for (const v of bad('r')) {
      const errs = dirValueErrors({ [a]: { [b]: v } });
      assert.equal(errs.length, 1, `${key} ${JSON.stringify(v)}: ${errs}`);
      assert.ok(errs[0].startsWith(`${key} ${JSON.stringify(v)} `), errs[0]);
    }
    for (const v of good) assert.deepEqual(dirValueErrors({ [a]: { [b]: v } }), [], `${key} ${v}`);
  }
  assert.deepEqual(dirValueErrors({ verification: {}, agents: { skills: [] } }), [], 'an unset dir is left to the defaults');
  assert.equal(dirValueErrors({ x: [{ some_dir: '/abs' }] }).length, 1, 'any *_dir key, wherever it sits');
});

function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-dirvals-')); scratch.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
  c.gates.required = []; c.agents.rules = []; c.constraints = { rules: [] };
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base');
  const eng = args => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ENG_STANDARD_SOURCE: PKG } });
  const s = eng(['sync']); assert.equal(s.status, 0, out(s));
  git('add -A'); git('commit -qm synced');
  return { dir, eng, base: c };
}
// Every path under the repo (but .git) with its bytes, and the parent folder's entries: what a refusal must leave alone.
function shot(dir) {
  const s = { parent: fs.readdirSync(path.dirname(dir)).sort().join('\n') };
  const walk = rel => { const abs = path.join(dir, rel); const st = fs.lstatSync(abs); if (st.isDirectory()) { s[rel] = 'dir'; for (const n of fs.readdirSync(abs).sort()) if (!(rel === '' && n === '.git')) walk(path.join(rel, n)); } else s[rel] = st.isSymbolicLink() ? `link:${fs.readlinkSync(abs)}` : fs.readFileSync(abs, 'utf8'); };
  walk('');
  return s;
}

test('eng sync, sync --check and init refuse a bad checks_dir or agents.skills_dir with exit 1 and write nothing', () => {
  const r = repo(), name = path.basename(r.dir);
  for (const [a, b] of [['verification', 'checks_dir'], ['agents', 'skills_dir']]) {
    for (const v of bad(name)) {
      const c = structuredClone(r.base); c[a][b] = v;
      fs.writeFileSync(path.join(r.dir, 'eng.config.yml'), YAML.stringify(c));
      const before = shot(r.dir);
      for (const args of [['sync'], ['sync', '--check'], ['init']]) {
        const res = r.eng(args), why = `${a}.${b} ${JSON.stringify(v)}: eng ${args.join(' ')}`;
        assert.equal(res.status, 1, `${why} refuses: ${out(res).slice(-1500)}`);
        assert.ok(out(res).includes(`${a}.${b} ${JSON.stringify(v)} `), `${why} names the key and value: ${out(res).slice(-1500)}`);
        assert.deepEqual(shot(r.dir), before, `${why} wrote nothing`);
      }
    }
  }
  for (const [a, b, v] of [['verification', 'checks_dir', 'ci/checks'], ['agents', 'skills_dir', 'tools/skills']]) {
    const c = structuredClone(r.base); c[a][b] = v;
    fs.writeFileSync(path.join(r.dir, 'eng.config.yml'), YAML.stringify(c));
    const res = r.eng(['sync']); assert.equal(res.status, 0, `${a}.${b} ${v} syncs: ${out(res)}`);
    assert.ok(fs.existsSync(path.join(r.dir, v)), `${v} written`);
    const chk = r.eng(['sync', '--check']); assert.equal(chk.status, 0, out(chk));
  }
});
