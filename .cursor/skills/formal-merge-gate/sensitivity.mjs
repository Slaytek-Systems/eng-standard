#!/usr/bin/env node
// Shows that check.mjs can fail. Each fault below breaks one merge rule in a scratch copy of lib/ (never the checkout),
// and check.mjs --property read must report a counterexample for it in the named scenario.
// Usage: node sensitivity.mjs [--src <eng-standard checkout>] [--only <fault>]
// Exit 0: every fault caught. 1: a fault missed. 2: a fault's anchor text is not in the code exactly once (the code moved:
// update the fault to break the same rule in the new code).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(opt('--src') || path.join(HERE, '../../..'));

const FAULTS = [
  { name: 'any account ends a run', rule: 'only the owner or a verifier_logins login ends a run', scenario: 'run-ownership',
    from: '(s.login === start.login || (logins ?? []).includes(s.login))', to: 'true' },
  { name: 'the latest pending starts a run', rule: "a run's owner and deadline come from its first pending status", scenario: 'run-ownership',
    from: "const start = list.find(s => s.state === 'pending');", to: "const start = list.findLast(s => s.state === 'pending');" },
  { name: 'a dead run expires a second early', rule: 'a dead run holds until first pending + timeout + 5 minutes', scenario: 'dead-runs',
    from: 'if (!(now >= until)', to: 'if (!(now + 1000 >= until)' },
  { name: 'no run guard', rule: "a PASS does not count while its verifier's run is in progress", scenario: 'dead-runs',
    from: 'passProblem(v, testable) || still(v)', to: 'passProblem(v, testable)' },
  { name: "a verifier's first verdict counts", rule: "each verifier's latest verdict counts", scenario: 'run-ownership',
    from: 'const latest = [...new Map(forHead.map(v => [v.key, v])).values()];', to: 'const latest = [...new Map(forHead.toReversed().map(v => [v.key, v])).values()];' },
  { name: 'any write-access login counts', rule: 'only verifier_logins verdict comments count', scenario: 'run-ownership',
    from: 'trusted(state.verdicts || [], c.verifier_logins)', to: 'trusted(state.verdicts || [], null)' },
  { name: 'risk:high needs one verifier', rule: 'risk:high needs ship.high_risk.verifiers distinct verifiers', scenario: 'two-verifiers',
    from: 'high ? c.high_verifiers : 1', to: '1' },
  { name: 'a verdict for any head counts', rule: 'only verdicts for the exact head count', scenario: 'heads',
    from: 'const forHead = verdicts.filter(v => v.sha === headSha);', to: 'const forHead = verdicts;' },
  { name: 'a behind head merges', rule: "the head contains main's tip", scenario: 'heads',
    from: 'if (state.containsBase !== true)', to: 'if (false)' },
  { name: 'the hold label is ignored', rule: 'no hold label', scenario: 'hold-label',
    from: 'if (pr.labels.includes(c.hold_label)) return no', to: 'if (false) return no' },
];

const only = opt('--only'), faults = only ? FAULTS.filter(f => f.name === only) : FAULTS;
if (!faults.length) { console.error(`no fault named ${JSON.stringify(only)}; faults: ${FAULTS.map(f => f.name).join('; ')}`); process.exit(2); }
const original = fs.readFileSync(path.join(SRC, 'lib/self-merge.mjs'), 'utf8');
const stale = faults.filter(f => original.split(f.from).length !== 2);
if (stale.length) { for (const f of stale) console.log(`STALE ${f.name}: lib/self-merge.mjs does not contain its anchor exactly once: ${f.from}`); process.exit(2); }

let missed = 0;
for (const f of faults) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-merge-gate-'));
  try {
    fs.cpSync(path.join(SRC, 'lib'), path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'eng.config.yml'), path.join(dir, 'eng.config.yml'));
    fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'lib/self-merge.mjs'), original.replace(f.from, f.to));
    const r = spawnSync(process.execPath, ['--max-old-space-size=1024', path.join(HERE, 'check.mjs'), '--src', dir, '--scenario', f.scenario], { encoding: 'utf8' });
    const caught = r.status === 1 && /^FAIL /m.test(r.stdout);
    if (!caught) missed++;
    console.log(`${caught ? 'CAUGHT' : 'MISSED'} ${f.name} (breaks: ${f.rule}; scenario ${f.scenario})`);
    if (!caught || args.includes('--show')) console.log((r.stdout + r.stderr).replace(/^/gm, '    ').trimEnd());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
process.exit(missed ? 1 : 0);
