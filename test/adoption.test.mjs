// The Kalsigns adoption of v0.16 (8 Nov 2026) hit five gaps; each test here is the next adopter's repo meeting one of them.
// Evidence: Core nd7cpb3k1atph5xsgdfzt4nm4d8ht44g and the Kalsigns dispatch README, "eng-standard gaps".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { enforcer } from '../lib/budget.mjs';
import { openSockDir, runTmpRoot } from '../lib/hygiene.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.dirname(path.dirname(ENG));
const TPL = path.join(PKG, 'templates/eng.config.yml');
const out = r => r.stdout + r.stderr;
const systemd = (() => { try { return enforcer({}) === 'systemd'; } catch { return false; } })();
const scratch = [];
after(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

// A fresh repo on the template config: no required gates, ephemeral runs unwatched, one run per check.
function repo(edit = c => c) {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-adopt-')); scratch.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  c.gates.required = []; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.verification.flake_runs = 1;
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(edit(c)));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base');
  const eng = (args, env = {}) => { const e = { ...process.env, ...env }; if (!('CI' in env)) delete e.CI; return spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: e }); };
  const checks = files => {
    fs.mkdirSync(path.join(dir, '.eng/checks'), { recursive: true });
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.eng/checks', `${n}.sh`), body, { mode: 0o755 });
    git('add -A'); git('commit -qm checks --allow-empty');
  };
  return { dir, git, eng, checks };
}
// ---------- 1. PR template: GitHub reads .github/, the root or docs/, any case, and a PULL_REQUEST_TEMPLATE/ folder ----------
const ENG_TEMPLATE = '.github/pull_request_template.md';
for (const own of ['.github/PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE/feature.md'])
  test(`a repo with its own PR template (${own}) keeps it: eng sync renders none, touches none, and eng doctor names it`, () => {
    const { dir, eng } = repo();
    fs.mkdirSync(path.dirname(path.join(dir, own)), { recursive: true });
    fs.writeFileSync(path.join(dir, own), '## Our template\n');
    let r = eng(['sync']);
    assert.equal(r.status, 0, out(r));
    assert.equal(fs.readFileSync(path.join(dir, own), 'utf8'), '## Our template\n', 'the repo\'s own template is untouched');
    assert.ok(!(fs.existsSync(path.join(dir, '.github')) && fs.readdirSync(path.join(dir, '.github')).includes('pull_request_template.md')), `eng rendered no ${ENG_TEMPLATE} beside ${own}: ${out(r)}`);
    r = eng(['sync', '--check']);
    assert.equal(r.status, 0, out(r));
    r = eng(['doctor'], { ENG_STANDARD_SOURCE: PKG });
    const named = own.endsWith('/feature.md') ? path.dirname(own) : own;
    assert.match(r.stdout, new RegExp(`PR template: ${named.replace(/[./]/g, '\\$&')} \\(the repo's own; eng renders none\\)`), out(r));
  });

test('eng keeps rendering its PR template when it is the only one, and a second sync changes nothing', () => {
  const { dir, eng, git } = repo();
  let r = eng(['sync']);
  assert.equal(r.status, 0, out(r));
  assert.match(fs.readFileSync(path.join(dir, ENG_TEMPLATE), 'utf8'), /\S/, 'eng\'s template is written');
  git('add -A'); git('commit -qm sync');
  r = eng(['sync']); assert.match(r.stdout, /eng sync: no changes/, out(r));
  r = eng(['doctor'], { ENG_STANDARD_SOURCE: PKG });
  assert.match(r.stdout, /PR template: \.github\/pull_request_template\.md \(eng's\)/, out(r));
});

// ---------- 2. per-step TMPDIR short enough for a unix socket (tsx IPC: $TMPDIR/tsx-<uid>/<pid>.pipe) ----------
// The repo name is long on purpose: before, it appeared twice in every step's TMPDIR.
const SOCK_CHECK = `#!/usr/bin/env bash
mkdir -p "$TMPDIR/tsx-1000"
for p in "$TMPDIR/tsx-1000/12345.pipe" "$TMPDIR/${'s'.repeat(40)}"; do
  echo "socket path $p (\${#p} bytes)"
  node -e 'const s=require("net").createServer().listen(process.argv[1],()=>{console.log("bound "+process.argv[1]);s.close()}).on("error",e=>{console.log("Error: "+e.code+" "+process.argv[1]);process.exit(1)})' "$p" || exit 1
done
rm -rf "$TMPDIR/tsx-1000"
`;
for (const how of ['systemd', 'watchdog']) for (const via of ['eng gate', 'eng run -- eng gate'])
  test(`a check binds unix sockets in its TMPDIR through ${via} (${how})`, t => {
    if (how === 'systemd' && !systemd) return t.skip('systemd-run --user --scope does not work on this machine');
    const { eng, checks } = repo(c => { c.project.name = 'kalsigns-quote-versions-workspace'; return c; });
    checks({ sock: SOCK_CHECK });
    const gate = ['gate', 'checks'], r = eng(via === 'eng gate' ? gate : ['run', '--', process.execPath, ENG, ...gate], { ENG_BUDGET_ENFORCER: how });
    t.diagnostic(out(r));
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /pass\s+check:sock/);
  });
test('a command binds unix sockets in its TMPDIR through eng run --, and the folder is gone after the run', () => {
  const { eng, checks } = repo(c => { c.project.name = 'kalsigns-quote-versions-workspace'; return c; });
  checks({ sock: SOCK_CHECK });
  const r = eng(['run', '--', 'bash', '.eng/checks/sock.sh']);
  assert.equal(r.status, 0, out(r));
  assert.equal(out(r).match(/^bound /gm)?.length, 2, out(r));
  const tmp = r.stdout.match(/TMPDIR=(\S+);/)?.[1];
  assert.ok(tmp && !fs.existsSync(tmp), `the run's TMPDIR ${tmp} is removed on exit`);
});

// The sandbox binds a private dir over /tmp, so its run folder must not be under /tmp: this test keeps its own under the home.
const bwrapOk = (() => { const d = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'eng-adopt-probe-')); try { return spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', d, '/tmp', '--', 'true']).status === 0; } finally { fs.rmSync(d, { recursive: true, force: true }); } })();
test('a gate check\'s TMPDIR is still there inside a sandboxed eng run <name> that the check starts', t => {
  if (!bwrapOk || os.homedir().startsWith('/tmp/')) return t.skip('needs a usable bwrap (nested bwrap is refused, so this runs under plain npm test) and a home outside /tmp');
  const xdg = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'eng-adopt-xdg-')); t.after(() => fs.rmSync(xdg, { recursive: true, force: true }));
  const { eng, checks } = repo(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'warn'; c.project.commands.probe = 'test -d "$PARENT_TMP" && test -w "$PARENT_TMP"'; return c; });
  checks({ nested: `#!/usr/bin/env bash\nexport PARENT_TMP="$TMPDIR"\nnode ${ENG} run probe\n` });
  const r = eng(['gate', 'checks'], { XDG_CACHE_HOME: xdg });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /pass\s+check:nested/);
});
test('eng gate removes the TMPDIR folder of a killed eng run, as the next eng run does', t => {
  if (os.homedir().startsWith('/tmp/')) return t.skip('needs a home outside /tmp');
  const { eng, checks } = repo();
  checks({ ok: '#!/usr/bin/env bash\ntrue\n' });
  const dead = openSockDir(process.env, 'eng-run-zz-999999999-0', runTmpRoot(process.env));
  t.after(() => fs.rmSync(dead, { recursive: true, force: true }));
  assert.ok(fs.existsSync(dead));
  const r = eng(['gate', 'checks']);
  assert.equal(r.status, 0, out(r));
  assert.ok(!fs.existsSync(dead), 'the gate reaps a folder whose eng is gone');
});

// ---------- 3. a failing step's reason names a failing line, and the end of its output is printed; eng keeps no file ----------
const TAP = `TAP version 13
ok 1 - reports failed uploads
ok 2 - retries failed jobs
not ok 3 - totals the quote
  ---
  error: 'Expected 10, got 9'
  ...
# pass 2
# fail 1
`;
const NODE_TEST = `✔ reports failed uploads (1.2ms)
✔ marks failed payments as retryable (0.8ms)
✖ totals the quote (2.1ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1
`;
const COLOR = '\x1b[32m✓ reports Error: upload failure\x1b[0m\n\x1b[31m× totals the quote\x1b[0m\n';
const TAIL_HEAD = /^eng gate: (\S+) failed; the end of its output \(at most 40 lines, 8 KiB\):$/;
// The gate's stderr, split into each failed step's printed tail.
const tails = r => {
  const outv = {}; let cur = null;
  for (const l of r.stderr.split('\n')) { const m = l.match(TAIL_HEAD); if (m) outv[cur = m[1]] = []; else if (cur && l.startsWith('eng: FAIL gate:')) cur = null; else if (cur) outv[cur].push(l); }
  return Object.fromEntries(Object.entries(outv).map(([k, v]) => [k, v.join('\n')]));
};
const files = d => { try { return fs.readdirSync(d, { recursive: true }); } catch { return []; } };
for (const [kind, output, why] of [['TAP', TAP, /not ok 3 - totals the quote/], ['node --test', NODE_TEST, /✖ totals the quote/], ['coloured vitest', COLOR, /× totals the quote/]])
  test(`a failing check's reason is a failing line, never a passing test (${kind}), and the gate prints the end of its output`, () => {
    const { eng, checks } = repo();
    checks({ suite: `#!/usr/bin/env bash\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit 1\n` });
    const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
    assert.equal(r.status, 1, out(r));
    const row = r.stdout.split('\n').find(l => /FAIL\s+check:suite/.test(l));
    assert.ok(row, out(r));
    assert.match(row, why, `the reason is the failing test: ${row}`);
    assert.doesNotMatch(row, /reports failed uploads|retries failed jobs|marks failed payments|upload failure/);
    assert.equal(tails(r)['check:suite'], output.trimEnd(), out(r));
    assert.doesNotMatch(out(r), /full output:/);
  });

test('a failing step writes no file: none in the cache, and none in the repo when XDG_CACHE_HOME is inside it', () => {
  const { dir, eng, checks, git } = repo();
  checks({ suite: '#!/usr/bin/env bash\necho not ok 1 - broke\nexit 1\n' });
  const before = files(process.env.XDG_CACHE_HOME);
  let r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.deepEqual(files(process.env.XDG_CACHE_HOME).filter(f => /failed/.test(f)), before.filter(f => /failed/.test(f)), 'no failure log under XDG_CACHE_HOME');
  r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog', XDG_CACHE_HOME: path.join(dir, '.cache') });
  assert.equal(r.status, 1, out(r));
  assert.equal(git('ls-files --others --exclude-standard'), '', 'the failing gate left nothing in the repo');
});

test('a check that exits 0 but fails for what it left in its TMPDIR prints the end of its output', () => {
  const { eng, checks } = repo();
  checks({ leaky: '#!/usr/bin/env bash\necho DIAGNOSTIC\ntouch "$TMPDIR/leak"\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /FAIL\s+check:leaky\s+left 1 entry in its private TMPDIR: leak/);
  assert.match(tails(r)['check:leaky'] ?? '', /^DIAGNOSTIC$/m, out(r));
});

test('two failing checks whose names slug alike each print their own output', () => {
  const { eng, checks } = repo();
  checks({ 'a+b': '#!/usr/bin/env bash\necho OUT-PLUS\nexit 1\n', 'a-b': '#!/usr/bin/env bash\necho OUT-MINUS\nexit 1\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' }), t = tails(r);
  assert.equal(r.status, 1, out(r));
  assert.match(t['check:a+b'] ?? '', /OUT-PLUS/, out(r)); assert.doesNotMatch(t['check:a+b'], /OUT-MINUS/);
  assert.match(t['check:a-b'] ?? '', /OUT-MINUS/, out(r)); assert.doesNotMatch(t['check:a-b'], /OUT-PLUS/);
});

const NOISY = `printf 'FIRST\\n'; head -c 2097152 /dev/zero | tr '\\0' x; printf '\\nLAST\\n'; exit 1`;
test('a very noisy failing gate command fails as itself (exit 1, not killed) and prints the end of its output, bounded', () => {
  const { eng } = repo(c => { c.gates.required = ['test']; c.project.commands.test = NOISY; return c; });
  const r = eng(['gate', 'test'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  assert.doesNotMatch(r.stderr, /interrupted/);
  const t = tails(r).test ?? '';
  assert.match(t, /LAST$/, out(r).slice(-2000)); assert.doesNotMatch(t, /FIRST/);
  assert.ok(Buffer.byteLength(t) <= 8192, `at most 8 KiB: ${Buffer.byteLength(t)}`);
});

test('a very noisy failing check prints at most 40 lines and 8 KiB of its end', () => {
  const { eng, checks } = repo();
  checks({ noisy: '#!/usr/bin/env bash\necho FIRST-LINE\nseq 1 100000\nhead -c 3000000 /dev/zero | tr "\\0" "x"\necho\necho LAST-LINE\nexit 1\n' });
  const r = eng(['gate', 'checks'], { ENG_BUDGET_ENFORCER: 'watchdog' });
  assert.equal(r.status, 1, out(r));
  const t = tails(r)['check:noisy'] ?? '';
  assert.match(t, /LAST-LINE$/, out(r).slice(-2000)); assert.doesNotMatch(t, /FIRST-LINE/);
  assert.ok(Buffer.byteLength(t) <= 8192 && t.split('\n').length <= 40, `bounded: ${Buffer.byteLength(t)} bytes, ${t.split('\n').length} lines`);
});

// ---------- 4. (0.17.1 refused a symlinked .claude/skills; since 0.17.2 eng never writes there: test/harness-folders.test.mjs) ----------

// ---------- 5. a container a check starts is outside eng's budget unless docker is given the limits ----------
// The container lint is a nudge: a text scan of common shell forms cannot parse shell, so it warns and never fails.
const CONTAINER_WARN = /WARN \.eng\/checks\/tla\.sh:4: \[container-unbounded\] Container without a memory and CPU limit/;
test('eng lint warns on a check\'s docker or podman run without both --memory and --cpus, never fails on it, and is quiet on one that has them', () => {
  const { eng, checks, dir } = repo();
  const lint = body => { fs.rmSync(path.join(dir, '.eng/checks'), { recursive: true, force: true }); checks({ tla: `#!/usr/bin/env bash\n# weight: heavy\n# budget: memory=2G workers=2 timeout=10m\n${body}\n` }); return eng(['lint']); };
  for (const bad of [
    'docker run --rm --name tlc-$$ tlc:1 java -Xmx1g -jar tla2tools.jar -workers 2 Spec.tla',
    'podman run --rm --memory 2g img true',
    'docker container run --rm --cpus 2 img true',
    'docker run --rm \\\n  --memory-swap 2g \\\n  --cpus 2 img true',
    'eng run -- docker run --rm img true',
    'docker run --rm --memory=128m --cpus=1 image true; docker run --rm image true',
    'docker run --rm --memory=128m --cpus=1 img true && podman run --rm img true',
    'docker run --rm --memory=128m --cpus=1 img true | docker run --rm img cat',
    'docker run --rm image echo --memory=128m --cpus=1',
    'docker run --rm image true # --memory=128m --cpus=1',
    'docker run --rm --memory=0 --cpus=1 img true',
    'out=$(docker run --rm img true)',
    'docker run --rm --memory=128m -m0 --cpus=1 img true',
    'docker run --rm -m128m --memory=0 --cpus=1 img true',
    'docker run --rm -m 128m -m 0 --cpus=1 img true',
    'docker run --rm --memory=128m --cpus=1 --cpus=0 img true',
    'docker run --rm 2>/dev/null img true',
    'cat <<EOF\nsample\nEOF\ndocker run --rm img true',
  ]) {
    const r = lint(bad);
    assert.equal(r.status, 0, `a warning, not a failure: ${bad}\n${out(r)}`);
    assert.match(r.stdout, bad.startsWith('cat') ? /tla\.sh:7: \[container-unbounded\]/ : CONTAINER_WARN, bad);
    assert.match(r.stdout, /eng lint: PASS .*warning/, bad);
  }
  for (const ok of [
    'docker run --rm --name tlc-$$ --memory 1536m --cpus 2 tlc:1 true',
    'podman run --rm -m=1g --cpus=1 img true',
    'docker run --rm \\\n  --name "tlc-$$" \\\n  --memory "${ENG_BUDGET_HEAP_MB}m" \\\n  --cpus "$ENG_BUDGET_WORKERS" \\\n  img true',
    'docker run --rm --memory=128m --cpus .5 image true',
    'docker run --rm -m128m --cpus=0.5 img true',
    'docker run --rm --memory 1g --cpus 1.25 img true',
    'docker run --rm -it -e A=1 -v "$PWD:/w" -m 1g --cpus=1 img sh -c "echo --x"',
    'docker run --rm --memory=128m --cpus=1 img true; docker run --rm -m 64m --cpus .5 img true',
    '# docker run --rm img (a comment)',
    'docker ps',
    'docker run --rm -m0 --memory=128m --cpus=1 img true',
    'docker run --rm 2>/dev/null -m128m --cpus=1 img true',
    'docker run --rm >out.log 2>&1 -m128m --cpus=1 img true',
    'docker run --rm > out.log 2> err.log < in.txt -m128m --cpus=1 img true',
    'docker run --rm >>out.log &>all.log -m128m --cpus=1 img true',
    "cat <<'EOF'\ndocker run --rm img true\nEOF",
    'cat <<EOF\ndocker run --rm img true\nEOF',
    'cat <<-END >notes.txt\n\tdocker run --rm img true\n\tEND\ndocker run --rm -m1g --cpus=1 img true',
  ]) {
    const r = lint(ok);
    assert.equal(r.status, 0, `${ok}\n${out(r)}`);
    assert.doesNotMatch(out(r), /container-unbounded/, ok);
  }
  const proofs = out(eng(['rules', 'prove'])).match(/(heavy-tool|container)-unbounded: \S+/g);
  assert.deepEqual(proofs, ['heavy-tool-unbounded: bites', 'container-unbounded: bites'], 'each built-in fixture proves its own rule');
});

test('the container warning never fails eng gate or eng doctor, and an unbounded java still fails lint and the gate', () => {
  const { eng, checks } = repo(c => ({ ...c, gates: { ...c.gates, required: ['lint'] } }));
  checks({ tla: '#!/usr/bin/env bash\n# weight: light\nexit 0\ndocker run --rm img true\n' });
  const lint = eng(['lint']);
  assert.equal(lint.status, 0, out(lint)); assert.match(lint.stdout, CONTAINER_WARN);
  const gate = eng(['gate']);
  assert.equal(gate.status, 0, out(gate));
  const warned = eng(['doctor']);
  assert.match(warned.stdout, CONTAINER_WARN, 'doctor reports the container warning');
  checks({ tla: '#!/usr/bin/env bash\n# weight: light\nexit 0\ndocker run --rm -m1g --cpus=1 img true\n' });
  const clean = eng(['doctor']);
  assert.doesNotMatch(out(clean), /container-unbounded/);
  assert.equal(warned.status, clean.status, `doctor exits the same with and without the warning\n${out(warned)}\n${out(clean)}`);
  checks({ tla: '#!/usr/bin/env bash\n# weight: light\nexit 0\njava -jar tla2tools.jar Spec.tla\n' });
  const java = eng(['lint']);
  assert.equal(java.status, 1, out(java)); assert.match(java.stderr, /tla\.sh:4: \[heavy-tool-unbounded\] Heavy tool without a bound/);
  assert.equal(eng(['gate']).status, 1, 'the gate still fails on an unbounded JVM');
});

test('the catalog and the rendered budget text give the container pattern, and say docker enforces it, not eng', () => {
  const cat = YAML.parse(fs.readFileSync(path.join(PKG, 'standard/checks.yml'), 'utf8'));
  const c = cat.containers;
  assert.ok(c, 'standard/checks.yml has a containers entry');
  for (const flag of ['--memory', '--cpus', '--rm', '--name', "trap 'docker rm -f"]) assert.ok(c.pattern.includes(flag), `the pattern has ${flag}`);
  assert.match(c.enforced_by, /docker/i); assert.doesNotMatch(c.enforced_by, /eng enforces/i);
  const { dir, eng } = repo();
  assert.equal(eng(['sync']).status, 0);
  const agents = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(agents, /docker run.*--memory.*--cpus/);
  assert.match(agents, /docker (enforces|applies) (the|those) limits?/i);
  assert.match(agents, /trap 'docker rm -f/);
  for (const text of [agents, c.why]) {
    assert.doesNotMatch(text, /a timeout or a cancel removes it|when the check exits or is stopped|on a TERM or INT/, 'no claim that the trap runs when eng stops the check (PR #57 verdict 3)');
    assert.match(text, /eng does not\s+promise the trap runs/, 'says eng does not promise cleanup when it stops a check');
  }
  assert.match(agents, /--name "\$ENG_BUDGET_UNIT"/, 'names the container with the id eng exports to the check');
  assert.match(agents, /a wrapper function or a variable hides/, 'states what the lint cannot see');
  assert.match(agents, /`eng lint` and `eng doctor` warn.*never fails? (lint|the gate)/, 'says the container lint only warns');
  assert.match(agents, /a text check of common forms/, 'says the lint is a text check');
});
