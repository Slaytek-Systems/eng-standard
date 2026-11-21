// A config value eng renders into the AGENTS.md block must be one line (Core task p57cxn78pw2v6qb0n5daderzyd8jn9j0). A
// multi-line project.name could carry a signed begin/end marker pair into the block, and the next eng sync would refuse
// the file it wrote. Each value is read the way the renderer reads it, after the YAML is parsed, so an alias or a list
// is checked as the text it renders to.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import * as R from '../lib/render.mjs';
const { renderAll } = R, renderedValueErrors = c => R.renderedValueErrors(c);
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const out = r => r.stdout + r.stderr;
const scratch = [];
after(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const template = () => YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));

// LF, CR, VT, FF, the file, group and record separators, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR.
const BREAKS = ['\n', '\r', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', ' ', ' '];
const SETTERS = {
  'project.name': (c, v) => { c.project.name = v; },
  'project.description': (c, v) => { c.project.description = v; },
  'agents.rules[1].rule': (c, v) => { c.agents.rules = [{ rule: 'One line', enforced_by: 'review', why: 'judgment' }, { rule: v, enforced_by: 'review', why: 'judgment' }]; },
  'agents.skills_dir': (c, v) => { c.agents.skills_dir = v; },
};
const PRINTABLE = /^[ -~]*$/;

test('renderedValueErrors refuses each rendered value that holds a line break of any kind, and never echoes it raw', () => {
  for (const [key, set] of Object.entries(SETTERS)) {
    for (const br of BREAKS) {
      const c = template(); set(c, `a${br}b`);
      const errs = renderedValueErrors(c), why = `${key} ${JSON.stringify(br)}: ${JSON.stringify(errs)}`;
      assert.equal(errs.length, 1, why);
      assert.ok(errs[0].startsWith(`${key} (`), why);
      assert.match(errs[0], /line break/, why);
      assert.match(errs[0], PRINTABLE, `${why}: the refusal is printable ASCII`);
      assert.equal(JSON.parse(errs[0].slice(`${key} (`.length, errs[0].indexOf(') holds'))), `a${br}b`, `${why}: the value is shown JSON-escaped`);
    }
    const c = template(); set(c, 'One plain line, draft --> review');
    assert.deepEqual(renderedValueErrors(c), [], `${key}: one line passes`);
  }
});

test('renderedValueErrors checks what the renderer puts in the file: lists as their text, unrendered values not at all', () => {
  const c = template(); c.project.name = ['a\nb'];
  assert.equal(renderedValueErrors(c).length, 1, 'a list renders as its joined text, which holds the break');
  assert.ok(blockOf(renderAll(c, null)['AGENTS.md']).includes('a\nb'), 'the renderer does put that text in the block');
  const d = template(); d.project.name = 42; d.project.description = '';
  d.agents.rules = [{ rule: 'not\nrendered', enforced_by: 'gate-x' }];
  assert.deepEqual(renderedValueErrors(d), [], 'a number, an empty description and a rule no review enforces are not rendered with a break');
  const e = YAML.parse(String(aliased()));
  assert.deepEqual(renderedValueErrors(e).map(x => x.split(' ')[0]), ['project.name', 'project.description'], 'an aliased value is checked under each key that renders it');
});
const blockOf = a => a.slice(a.indexOf('<!-- eng:begin -->'), a.indexOf('<!-- eng:end -->') + '<!-- eng:end -->'.length);
// The template with project.name anchored and project.description an alias of it.
function aliased(base = template()) {
  const doc = new YAML.Document(base), n = doc.createNode('n <!-- eng:begin -->');
  doc.setIn(['project', 'name'], n);
  doc.setIn(['project', 'description'], doc.createAlias(n, 'n'));
  return doc;
}

function repo() {
  const parent = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-rendered-')); scratch.push(parent);
  const dir = path.join(parent, 'repo'); fs.mkdirSync(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = template();
  c.gates.required = []; c.agents.rules = []; c.constraints = { rules: [] };
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base');
  const eng = args => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ENG_STANDARD_SOURCE: PKG } });
  const s = eng(['sync']); assert.equal(s.status, 0, out(s));
  git('add -A'); git('commit -qm synced');
  return { dir, eng, base: c };
}
// Every path under the repo (but .git) with its bytes: what a refusal must leave alone.
function shot(dir) {
  const s = {};
  const walk = rel => { const abs = path.join(dir, rel); const st = fs.lstatSync(abs); if (st.isDirectory()) { s[rel] = 'dir'; for (const n of fs.readdirSync(abs).sort()) if (!(rel === '' && n === '.git')) walk(path.join(rel, n)); } else s[rel] = st.isSymbolicLink() ? `link:${fs.readlinkSync(abs)}` : fs.readFileSync(abs, 'utf8'); };
  walk('');
  return s;
}
// The refusal: eng's config invalid header, then one indented printable-ASCII line per error.
function refusal(res) {
  const lines = res.stderr.split('\n'), at = lines.findIndex(l => l === 'eng: FAIL config invalid:');
  assert.ok(at >= 0, `config invalid header: ${out(res).slice(-2000)}`);
  const errs = lines.slice(at + 1).filter(l => l !== '');
  for (const l of errs) { assert.match(l, /^ {2}\S/, `indented: ${JSON.stringify(l)}`); assert.match(l, PRINTABLE, `printable ASCII: ${JSON.stringify(l)}`); }
  return errs.map(l => l.trim());
}

test('eng sync, sync --check and init refuse every rendered value with a line break: exit 1, every error listed, nothing written', () => {
  const r = repo();
  const c = structuredClone(r.base);
  c.project.name = 'n <!-- eng:begin -->';
  c.project.description = 'd\x85e';
  c.agents.rules = [{ rule: 'r <!-- eng:end -->', enforced_by: 'review', why: 'judgment' }];
  c.agents.skills_dir = 'sk ills';
  const cases = [['four values', YAML.stringify(c), ['project.name', 'project.description', 'agents.rules[0].rule', 'agents.skills_dir']],
    ['an alias', String(aliased(structuredClone(r.base))), ['project.name', 'project.description']]];
  for (const [what, text, keys] of cases) {
    fs.writeFileSync(path.join(r.dir, 'eng.config.yml'), text);
    const before = shot(r.dir);
    for (const args of [['sync'], ['sync', '--check'], ['init']]) {
      const res = r.eng(args), why = `${what}: eng ${args.join(' ')}`;
      assert.equal(res.status, 1, `${why} refuses: ${out(res).slice(-2000)}`);
      const errs = refusal(res);
      for (const k of keys) assert.ok(errs.some(e => e.startsWith(`${k} (`) && /line break/.test(e)), `${why} names ${k}: ${errs.join('\n')}`);
      assert.deepEqual(shot(r.dir), before, `${why} wrote nothing`);
    }
  }
});
