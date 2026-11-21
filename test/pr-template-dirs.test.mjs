// A folder eng renders into that GitHub reads as a PULL_REQUEST_TEMPLATE/ folder is refused in config validation (Core
// task p57daqhz3j9c0v0n0ntr93y3bs8jn2cd). Before, agents.skills_dir: docs/pull_request_template made eng init write
// .github/pull_request_template.md, because the plan was made before the skills folder existed; the next
// eng sync --check then counted that folder as the repo's own PR template, dropped eng's template from its plan and
// failed with 'config changed since last sync'.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const env = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };

function repo(config) {
  const dir = tmp('eng-prdir-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), config);
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  return { dir, eng, file: p => path.join(dir, p) };
}
const withSkillsDir = d => TPL.replace(/^( {2}skills_dir:).*$/m, `$1 ${JSON.stringify(d)}`);
const withChecksDir = d => TPL.replace(/^( {2}checks_dir:).*$/m, `$1 ${JSON.stringify(d)}`);
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};

const cases = [
  ['agents.skills_dir', withSkillsDir, 'docs/pull_request_template'],
  ['agents.skills_dir', withSkillsDir, '.github/PULL_REQUEST_TEMPLATE/skills'],
  ['agents.skills_dir', withSkillsDir, 'Pull_Request_Template'],
  ['agents.skills_dir', withSkillsDir, 'DOCS/pull_request_template/x'],
  ['verification.checks_dir', withChecksDir, 'docs/pull_request_template'],
  ['verification.checks_dir', withChecksDir, '.github/pull_request_template/checks'],
];
for (const [key, cfg, d] of cases) {
  test(`${key}: ${d} is refused by init, sync and sync --check with one line naming the key, before any write`, () => {
    const r = repo(cfg(d)), before = snapshot(r.dir);
    for (const args of [['init'], ['sync'], ['sync', '--check']]) {
      const s = r.eng(...args), what = `${args.join(' ')}: ${s.stdout}${s.stderr}`;
      assert.equal(s.status, 1, what);
      const lines = s.stderr.split('\n').filter(l => l.includes(key));
      assert.equal(lines.length, 1, what);
      assert.match(lines[0], /PR template/, what);
      assert.doesNotMatch(s.stderr, /node:internal|\n\s+at /, what);
      assert.deepEqual(snapshot(r.dir), before, `${args.join(' ')} wrote nothing`);
    }
  });
}

// A folder named like a template file holds no template for GitHub, so it is not one of the repo's own; a name that only
// starts like one is a plain folder. Both stay allowed, and sync --check agrees with the init before it.
for (const d of ['docs/pull_request_template.md', 'docs/pull_request_templates', 'other/pull_request_template']) {
  test(`agents.skills_dir: ${d} is allowed, and sync --check agrees with init`, () => {
    const r = repo(withSkillsDir(d));
    const i = r.eng('init'); assert.equal(i.status, 0, i.stdout + i.stderr);
    const c = r.eng('sync', '--check'); assert.equal(c.status, 0, c.stdout + c.stderr);
  });
}

// The dangling docs -> .eng/x shape from the task: docs is a link, so eng lists no template through it, and the folder
// sync creates at .eng/x/pull_request_template never becomes the repo's own.
test('a dangling docs -> .eng/x link with skills_dir .eng/x/pull_request_template: sync --check agrees with init', () => {
  const r = repo(withSkillsDir('.eng/x/pull_request_template'));
  fs.symlinkSync('.eng/x', r.file('docs'));
  const i = r.eng('init'); assert.equal(i.status, 0, i.stdout + i.stderr);
  assert.ok(fs.existsSync(r.file('.github/pull_request_template.md')), 'eng rendered its PR template');
  const c = r.eng('sync', '--check'); assert.equal(c.status, 0, c.stdout + c.stderr);
});

// Review round 1 on #121: the value is shown JSON-quoted, so a newline in it cannot split the line.
test('a skills_dir with a newline inside a PR template folder is refused on one line', () => {
  const r = repo(withSkillsDir('docs/pull_request_template/a\nb'));
  const s = r.eng('sync');
  assert.equal(s.status, 1, s.stdout + s.stderr);
  const lines = s.stderr.split('\n').filter(l => l.includes('agents.skills_dir'));
  assert.equal(lines.length, 1, s.stderr);
  // Since v0.23.25 a line break in a rendered value is refused by the *_dir check, once, before the PR template check.
  assert.match(lines[0], /agents\.skills_dir "docs\/pull_request_template\/a\\nb" holds a line break: /, s.stderr);
});

// Review round 1 on #121: with skills_dir docs or .github, the empty-folder cleanup after a sync must leave the
// repo's own PR template folder alone, even an empty one, or the next sync --check plans eng's template and fails.
for (const [sd, own] of [['docs', 'docs/pull_request_template'], ['.github', '.github/PULL_REQUEST_TEMPLATE']]) {
  test(`skills_dir ${sd}: sync keeps an empty ${own} folder, and sync --check agrees`, () => {
    const r = repo(withSkillsDir(sd));
    fs.mkdirSync(r.file(own), { recursive: true });
    fs.mkdirSync(r.file(`${own}/empty`));
    const s = r.eng('sync'); assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.ok(fs.existsSync(r.file(`${own}/empty`)), `${own}/empty is still there`);
    assert.ok(!fs.existsSync(r.file('.github/pull_request_template.md')), 'eng rendered no template beside the repo\'s own');
    const c = r.eng('sync', '--check'); assert.equal(c.status, 0, c.stdout + c.stderr);
  });
}

// Review round 2 on #121: U+2028 and U+2029 end a line for many readers, so every character outside printable ASCII in
// the value is written as \uXXXX, as parseConfig does for a repeated key.
test('a skills_dir with U+2028 inside a PR template folder is refused on one printable-ASCII line', () => {
  const r = repo(withSkillsDir('docs/pull_request_template/a\u2028b\u00e9'));
  const s = r.eng('sync');
  assert.equal(s.status, 1, s.stdout + s.stderr);
  const lines = s.stderr.split(/\r\n|[\n\r\u2028\u2029\u0085]/).filter(l => l.includes('agents.skills_dir'));
  assert.equal(lines.length, 1, s.stderr);
  assert.match(lines[0], /agents\.skills_dir "docs\/pull_request_template\/a\\u2028b\\u00e9" holds a line break: /, s.stderr);
  assert.match(lines[0], /^[ -~]*$/, s.stderr);
});

// Review round 2 on #121: a repo synced by an earlier eng with skills_dir docs/pull_request_template moves to skills_dir
// docs. The plan sees that folder (eng's old skills) as the repo's template, so pruning its files must not remove it,
// or the next sync --check plans eng's template and fails.
test('moving skills_dir from docs/pull_request_template to docs: sync --check agrees with the sync that prunes', () => {
  const r = repo(withSkillsDir('docs/tmpl'));
  const i = r.eng('init'); assert.equal(i.status, 0, i.stdout + i.stderr);
  // The state an earlier eng left: its skills in docs/pull_request_template, listed in the lock.
  fs.renameSync(r.file('docs/tmpl'), r.file('docs/pull_request_template'));
  const lock = r.file('.eng/lock.json');
  fs.writeFileSync(lock, fs.readFileSync(lock, 'utf8').replaceAll('"docs/tmpl/', '"docs/pull_request_template/'));
  fs.writeFileSync(r.file('eng.config.yml'), withSkillsDir('docs'));
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /removed docs\/pull_request_template\//, 'the old skills were pruned');
  const c = r.eng('sync', '--check'); assert.equal(c.status, 0, c.stdout + c.stderr);
});
