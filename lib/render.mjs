// Renders every generated file from eng.config.yml. Pure: config in, {path: content} out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePolicy } from './e2e-policy.mjs';
import { resolveFormal, formalText } from './formal.mjs';
import { budgetRules } from './budget.mjs';
import { modelsText, pstackModels } from './models.mjs';
import { standardText } from './standard.mjs';
import { rewriteMode } from './migrate.mjs';
import { profileText, fillProfile } from './profile.mjs';
import YAML from 'yaml';
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const LOCAL_ENG = `node_modules/${PKG_JSON.name}/${PKG_JSON.bin.eng}`;
const protectedBranches = cfg => [...new Set([cfg.project.default_branch, ...(cfg.project.protected_branches ?? [])])];
// eng renders an executable agent deny list, and the post-edit hook, for Claude Code only (.claude/settings.json). Every
// other harness gets the git hooks and this text. The rendered claims name which harnesses that is, from agents.harnesses.
export const DENY_HARNESSES = ['claude-code'];
export function agentGuard(cfg) {
  const hs = cfg.agents?.harnesses ?? [];
  return { deny: hs.some(h => DENY_HARNESSES.includes(h)), bare: hs.filter(h => !DENY_HARNESSES.includes(h)) };
}
// eng doctor: one line per selected harness naming what it gets and what it does not.
export function harnessLines(cfg) {
  const post = !!cfg.agents?.post_edit_command;
  // protected mode: .githooks/pre-push lets every feature-branch rewrite through, so only protected branches and tags are guarded.
  const push = rewriteMode(cfg) === 'protected'
    ? 'a raw force-push of a feature branch has no local guard (protected mode lets feature-branch rewrites through), protected branches and tags by .githooks/pre-push only (which --no-verify skips)'
    : 'a raw force-push by .githooks/pre-push only (which --no-verify skips)';
  return (cfg.agents?.harnesses ?? []).map(h => DENY_HARNESSES.includes(h)
    ? { ok: true, what: `${h}: agent deny list${post ? ' and post-edit hook' : ''} in .claude/settings.json` }
    : { ok: false, what: `${h}: no agent deny list; --no-verify and --admin are guarded by this text only, ${push}${post ? '; no post-edit hook (agents.post_edit_command runs in Claude Code only)' : ''}. CI required checks are the wall` });
}
const gap = g => `${g.bare.join(', ')}: no agent deny list`;
// The Claude Code deny list is prefix rules (Bash(git push --force:*) and the like): it catches the common forms only.
// PR #53 verdict 3: a flag later on the line (git commit -m x --no-verify) and bundled short flags (git push -vf) get through.
export const DENY_LIMIT = 'common forms only: a flag later on the line or bundled short flags such as `-vf` get through';
const wall = (g, hooks, mode = 'never') => {
  const names = hooks.map(h => `\`${h}\``), list = xs => `${xs.slice(0, -1).join(', ')}${xs.length > 1 ? ' and ' : ''}${xs.at(-1)}`;
  if (mode !== 'protected') {
    const by = [...names, ...(g.deny ? [`the Claude Code deny list (${DENY_LIMIT})`] : [])];
    // PR #53 verdict 4: pre-rebase can tell a commit was pushed only when the branch has an upstream.
    const rebase = hooks.includes('.githooks/pre-rebase') ? ' (`.githooks/pre-rebase` can tell a commit was pushed only when the branch has an upstream)' : '';
    return `${list(by)} enforce this locally${rebase}${g.bare.length ? ` (${gap(g)}, so the git hooks are their only local guard)` : ''}.`;
  }
  // protected: the hooks let every feature-branch rewrite through, so they guard protected branches and tags only, whatever the harnesses.
  const feature = g.deny
    ? `; the Claude Code deny list blocks a raw force-push on any branch (${DENY_LIMIT})${g.bare.length ? ` (${gap(g)}, so nothing local stops a raw force-push of a feature branch there)` : ''}`
    : `; ${g.bare.length ? `${gap(g)}, so ` : 'there is no agent deny list, so '}nothing local stops a raw force-push of a feature branch`;
  return `${list(names)} enforce this locally for protected branches and tags${feature}.`;
};
const pushCell = (g, mode = 'never') => mode === 'protected'
  ? `\`.githooks/pre-push\` (protected branches and tags)${g.deny ? ` + Claude Code deny list (any branch; ${DENY_LIMIT})` : ''} (local${g.bare.length ? `; ${gap(g)}, so no local guard on feature branches` : g.deny ? '' : '; no agent deny list, so no local guard on feature branches'}); server ruleset is the real wall for protected branches`
  : `\`.githooks/pre-push\`${g.deny ? ` + Claude Code deny list (${DENY_LIMIT})` : ''} (local${g.bare.length ? `; ${gap(g)}` : ''}); server ruleset is the real wall for protected branches`;
const bypassCell = g => `${g.deny ? `Claude Code deny list only (${DENY_LIMIT})` : 'this text only'}${g.bare.length ? ` (${gap(g)}${g.deny ? ', this text only' : ''})` : ''}; hooks cannot see these. CI required checks are the wall`;
// What each git.rewrite_pushed mode says and enforces.
const REWRITE = {
  never: {
    shipping: (g, P) => `1. **Never rewrite pushed history** (${P.never_by}\`git.rewrite_pushed: never\`).${P.never_why} Tidy commits with rebase or amend only before their first push. After a push, every follow-up is a new commit, and the base comes in by merge (\`gh pr update-branch <n>\`), never by rebase. No force-push of any kind on any branch; a pushed tag never moves. Protected branches (\`main\` and any in \`project.protected_branches\`) are also never deleted. Merges to \`main\` are squash merges, so the extra commits do not reach \`main\`. ${wall(g, ['.githooks/pre-push', '.githooks/pre-rebase'])}`,
    rules: (prot, g) => `| Rewrite only unpushed commits, and never on ${prot.join(', ')} | \`.githooks/pre-rebase\` (local; it can tell a commit was pushed only when the branch has an upstream) |
| Never rewrite pushed history: no force-push on any branch, no moving a pushed tag, no deleting a protected branch | ${pushCell(g)} |`,
    branches: (base, g, P) => `- Pushed history is never rewritten (${P.never_by}\`git.rewrite_pushed: never\`). Tidy commits with rebase or amend only before their first push. After that, every follow-up is a new commit, and \`origin/${base}\` comes in by merge (\`gh pr update-branch <n>\`), never by rebase. This overrides pstack's Opening a PR and stack advice wherever it says to rebase or amend pushed commits. A new head is a new commit and needs a new run and verdict.`,
    agent: (base, P) => `Pushed history is never rewritten${P.never_note}: after a push, every follow-up is a new commit, and \`origin/${base}\` comes in by merge (\`gh pr update-branch <n>\`), never by rebase. Never follow a skill that says to rebase, amend or force-push pushed commits.`,
  },
  protected: {
    shipping: (g, P) => `1. **Never rewrite protected history** (${P.protected_by}\`git.rewrite_pushed: protected\`, \`never\` is the recommended setting). \`main\`, any branch in \`project.protected_branches\` and every pushed tag are locked: no non-fast-forward push, no deletion, and a pushed tag never moves. A pushed feature branch may be rewritten only through the repo's guarded tool, for example Graphite's \`gt restack\` and lease-protected \`gt submit\`, never by hand. Agents never force-push with git${g.deny ? `; the Claude Code deny list blocks it in every mode (${DENY_LIMIT})` : ''}. Merges to \`main\` are squash merges. ${wall(g, ['.githooks/pre-push', '.githooks/pre-rebase'], 'protected')}`,
    rules: (prot, g) => `| Never rebase ${prot.join(', ')}; feature branches only through the repo's guarded tool | \`.githooks/pre-rebase\` (local, protected branches only); the guarded-tool rule is this text only |
| Never rewrite protected history: no non-fast-forward push or delete on ${prot.join(', ')}, no moving a pushed tag; no raw force-push by agents on any branch | ${pushCell(g, 'protected')} |`,
    branches: (base, g, P) => `- Feature branches may be rewritten after a push only through the repo's guarded tool (\`git.rewrite_pushed: protected\`), for example Graphite's \`gt restack\` and lease-protected \`gt submit\`. Protected branches are never rebased or rewritten, a pushed tag never moves, and agents never force-push with git${g.deny ? ` (Claude Code deny list, ${DENY_LIMIT})` : ''}. \`origin/${base}\` comes in through the guarded tool's restack or by merge (\`gh pr update-branch <n>\`). A new head is a new commit and needs a new run and verdict.`,
    agent: (base, P) => `Protected branches (\`${base}\` and \`project.protected_branches\`) and pushed tags are never rewritten. A pushed feature branch is rewritten only through the repo's guarded tool (for example Graphite's \`gt submit\`), never with a raw force-push (\`git.rewrite_pushed: protected\`).`,
  },
};

const HDR = (c = '#') => `${c} GENERATED by eng from eng.config.yml. Do not edit; edit the config and run \`eng sync\`.`;

export const BEGIN = '<!-- eng:begin -->', END = '<!-- eng:end -->';

function list(xs) { return (xs || []).map(x => `- ${x}`).join('\n'); }
function choice(c) { return `**${c.use}** — ${c.why} _(${c.decision || 'DRAFT'})_`; }

// Check ids from the repo's checks_dir (each is an executable behaviour check eng gate runs first).
export function checkIds(cfg) {
  const d = path.join(process.cwd(), cfg.verification?.checks_dir ?? '.eng/checks');
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.sh')).map(f => f.slice(0, -3)).sort() : [];
}
// One line per stage. Rendered into SHIPPING.md (Reference) and printed by `eng init`.
export const ROUTER = [
  ['plan', '`poteto-mode` (it picks the playbook: bug-fix, feature, refactoring ...), then `how` / `why` / `architect`; `figure-it-out` for large work; `grilling` / `grill-with-docs` for product calls; `find-the-laws` for rules that must always hold'],
  ['build', 'the playbook steps; `tdd` for bug fixes; `typescript-best-practices` on every .ts/.tsx edit; `show-me-your-work` for long or unattended runs'],
  ['verify', '`principle-prove-it-works`, the repo `verify-<app>` skill (use it wherever pstack says `control-cli` / `control-ui`); the verifier runs each check on the exact commit with `eng run --by <id> -- <cmd>` (app, e2e, property and mutation tests, formal checks); `{stateful}` for a flow that moves between states, `{other}` for non-stateful high-cost code; `interrogate` (optional) for contested design and for text no check can run, `blast-radius` for small risky diffs'],
  ['ship', 'author: the Opening a PR playbook (`no-comments`, then `technical-writing` + `unslop`) up to merge-ready, never merge; shipping manager: the serial loop in SHIPPING.md'],
  ['retro', '`eng-retro` after each merged PR, then `correct` for any class it finds'],
];
export const ROUTE_RULE = 'To use a skill, read `.agents/skills/<name>/SKILL.md` and follow it. Do not rely on description matching or the Skill tool: most of these skills are manual-only and will not load on their own.';
export const STEER = 'Leads that spawn or steer coding threads{{steer_example}} start the message with one line naming the mode and the playbook, then the job, e.g. "/poteto-mode -> Shipping playbook: verify commit <sha> with verify-<app>, record eng verdict". This is the primary path; the router above is the fallback.';
export const SPAWN_RULE = 'one line naming the mode and playbook, e.g. "/poteto-mode -> Shipping playbook: verify commit <sha> with verify-<app>, record eng verdict".';
// Which poteto-mode playbook (vendor/pstack/skills/poteto-mode/playbooks/<file>) goes with which job.
export const PLAYBOOKS = [
  ['Drive the author\'s own PR to merge-ready (conflicts, review threads, CI). NOT verification', 'Babysit', 'playbooks/babysit.md', '/poteto-mode -> Babysit playbook (drive): get PR #<n> to merge-ready; you are the author side, not the verifier'],
  ['Verify a commit with the repo\'s verification tooling (eng run --by), record eng verdict, then land', 'Shipping', 'playbooks/shipping.md', '/poteto-mode -> Shipping playbook: verify commit <sha> with verify-<app>, record eng verdict'],
  ['Full autonomous program: one owner per PR from build to merge, root swarm-verifies each round', 'Autopilot-full', 'playbooks/autopilot-full.md', '/poteto-mode -> Autopilot-full playbook: run queue <list> to merge'],
  ['Full autonomy up to a verified linear stack the operator lands', 'Autopilot-stack', 'playbooks/autopilot-stack.md', '/poteto-mode -> Autopilot-stack playbook: build and verify <list> as one stack; do not merge'],
  ['Bug fix / feature / refactor', 'Bug fix, Feature, Refactoring', 'playbooks/bug-fix.md, feature.md, refactoring.md', '/poteto-mode -> Bug fix playbook: <issue>'],
];
export const SPAWN_RULES = [
  'Babysit is not verification. A babysitter drives the author\'s PR to merge-ready; the verdict comes from verification tooling run on the exact commit (eng run --by), and the builder may run it. pstack\'s Shipping playbook asks for a separate verifier agent; under this standard the runs decide, not who ran them.',
  'When the change adds a surface (route, screen, command, API, job) the repo\'s `verify-<app>` skill does not cover, the spawn message must also require `maintain-verification-skill` for that surface before the verdict.',
  'Write spawn and steer messages in plain prose with normal spacing between words. Re-read the message before sending; a message with its spaces stripped out is not sent.',
  '{{t3_send_rule}}',
];
// The profile fills {{steer_example}} and the T3 rule (empty in generic, so that line is dropped).
export function spawnText(cfg) {
  return `${fillProfile(STEER, cfg)}

| Job | Playbook | File (poteto-mode) | Spawn line |
|---|---|---|---|
${PLAYBOOKS.map(([j, p, f, l]) => `| ${j} | ${p} | \`${f}\` | \`${l}\` |`).join('\n')}

${SPAWN_RULES.map(r => fillProfile(r, cfg)).filter(Boolean).map(r => `- ${r}`).join('\n')}`;
}
// Server ruleset advice: non-strict required checks. eng never edits rulesets.
export function rulesetAdvice(cfg) {
  const b = cfg.project.default_branch;
  return `- Ruleset on \`${b}\`: require the gate status checks (\`${(cfg.gates?.required || []).join('`, `') || 'eng gate'}\`) and squash merge; block force-push and deletion.
- Required checks are NOT strict: leave "Require branches to be up to date before merging" (\`strict_required_status_checks_policy\` / \`strict\`) OFF. Strict up-to-date is not recommended: it forces an update-branch and a full re-run on every PR after every merge, serialising the queue for little safety.
- Safety comes from the full run on \`${b}\` after every merge plus an immediate revert on red (no fix-forward). A verdict counts only for the exact commit it ran on: an update-branch makes a new head, which needs its own run and verdict (\`eng verdict check\`).`;
}
export const CI_HYGIENE = [
  'No duplicate dispatches. Push once and let the push or pull_request trigger start CI. Do not also fire `workflow_dispatch`, `gh workflow run`, a Buildkite "New build" or a rebuild for the same SHA.',
  'Use `workflow_dispatch` (or a manual build) only deliberately: a run the triggers do not cover, or one re-run of a failed job you are investigating. Say why in the PR.',
  'Group runs with concurrency: one group per workflow and ref, e.g. `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == \'pull_request\' }} }`. Cancel superseded PR runs; never cancel runs on the default branch (the post-merge full run is the backstop). Buildkite: "Cancel intermediate builds" on PR branches only.',
];
// Linked from every rendered AGENTS.md and SHIPPING.md, whichever init path made them. Consuming repos do not ship principles/, so it is a URL.
// What each built-in gate name runs (eng gate and the rendered pipeline). Any other gate name runs project.commands.<name>.
export const GATE_COMMANDS = { verdict: 'verdict check', drift: 'sync --check', lint: 'lint', rules: 'rules prove', e2e: 'e2e --if-required', launch: 'doctor --launch', doctor: 'doctor' };
export const PRINCIPLES_LINE = 'Principle: [Slow down to speed up: trust is earned through systems built on formal verification](https://github.com/Slaytek-Systems/eng-standard/blob/main/principles/slow-down-to-speed-up.md). Read it before changing checks, gates or autonomy.';
export function routerText(cfg) {
  const f = resolveFormal(cfg.formal);
  return ROUTER.map(([k, v]) => `- **${k}:** ${v.replace(/\{(stateful|other)\}/g, (_, x) => f[x])}`).join('\n');
}

// The AGENTS.md block, read on every agent turn, so it holds only what passes the four-question test (Core decision,
// 10 Nov 2026): the agent cannot find it cheaply, a mistake costs before any check catches it, no enforcer can carry
// it, and it matters for nearly every task. Everything else is in SHIPPING.md (referenceText), enforcers and skills.
export function agentsBlock(cfg) {
  const P = profileText(cfg), s = cfg.agents.skills_dir, router = expandSkills(cfg).includes('eng/eng-route');
  return `${BEGIN}
<!-- ${HDR('').trim()} -->
## ${P.standard_title} (${cfg.project.name})
- Hooks, \`eng lint\`, \`eng gate\` and CI enforce this repo's rules. When one blocks you, take the route its message names; if it names none, find the rule in \`SHIPPING.md\`. Never bypass a check (\`--no-verify\`, \`--admin\`).
- Skills live in \`${s}/<name>/SKILL.md\`, and most will not load on their own. ${router ? `Read \`${s}/eng-route/SKILL.md\` to pick one` : 'Pick one with the skill router in \`SHIPPING.md\` (Reference)'}, then read that skill's file.
- \`SHIPPING.md\` has this repo's shipping rules and the reference for eng's commands, checks and skills.
${END}`;
}

// SHIPPING.md "Reference": what the AGENTS.md block carried before 0.19.0 that SHIPPING.md did not already say. The
// spawn guidance, CI hygiene and fixed rules stay in their own SHIPPING.md sections.
export function referenceText(cfg) {
  const c = cfg.project.commands, m = cfg.merge, P = profileText(cfg);
  return `## Reference

Read \`STACK.md\` before adding a language, framework or tool.

${PRINCIPLES_LINE}

${standardText(REWRITE[rewriteMode(cfg)].agent(cfg.project.default_branch, P))}

### Commands
| Gate | Command |
|---|---|
${Object.entries(c).map(([k, x]) => `| ${k} | \`${x}\` |`).join('\n')}
| everything | \`eng gate\`: every \`${cfg.verification?.checks_dir ?? '.eng/checks'}\` script first, then each gate (skipped or missing = failed) |
${cfg.e2e ? `| e2e needed? | \`eng e2e --required\`: ${e2ePolicyLine(cfg)} |\n` : ''}
${budgetRules(cfg.verification?.checks_dir ?? '.eng/checks')}

### Skill router
${ROUTE_RULE}
${routerText(cfg)}

### How work runs (pstack leads)
- Start any non-trivial task with the \`poteto-mode\` skill. It picks a playbook (bug fix, feature, refactoring ...), copies its steps into your todo list and calls the other pstack skills as steps need them. \`poteto-help\` answers "which skill?".
- Answer facts by running something (\`how\`, a prototype), not by asking. Ask the human only product or preference calls; use \`grilling\` / \`grill-with-docs\` for those, and \`domain-modeling\` for the glossary and ADRs.
- This repo needs one \`verify-<app>\` skill: generate it with \`create-verification-skill\`, keep it honest daily with \`maintain-verification-skill\`. \`e2e-flow\` is the Drive harness it calls.
${formalText(cfg.formal)}
${cfg.audits?.maintain_verification ? `- Daily audit (${cfg.audits.maintain_verification.schedule}): run \`maintain-verification-skill\` on \`${cfg.audits.maintain_verification.target}\` exactly as written. Outcome clean / changed (one PR, edits only that skill's dir) / blocked. Product bugs it finds are reported, never patched in docs. Schedule: \`.eng/ci/audit.yml\`.\n` : ''}${modelsText(cfg)}
- Host mapping (pstack is written for Cursor): \`Task\` = your agent's subagent tool; \`subagent_type: "poteto-agent"\` / \`"Comment Sicko"\` = the definitions in \`${path.dirname(cfg.agents.skills_dir)}/agents/\`; \`AskQuestion\` = ask the user; \`environment: "cloud"\` = a cloud or background agent if you have one, else a local worktree; model slugs = your host's equivalents; \`~/.cursor/projects/<slug>/agent-transcripts\` = your host's transcript store (Claude Code \`~/.claude/projects/<slug>/\`, Codex \`~/.codex/sessions/\`). \`setup-benny\`, \`triage-issue-reports\`, \`reproduce-and-fix-issues\` and \`make-bot-ui\` need Cursor Automations / Grok Bot routines and are installed but dormant.

### eng adds (each defers to the pstack skill named)
| eng | does | defers to |
|---|---|---|
| \`eng-verify\` | each check fails before the fix and passes after it; \`eng gate\` runs every check first, in CI too, and a failing check fails the gate whatever the verdict says | \`tdd\` + Bug fix step 5 (failing first), Shipping step 3, \`principle-prove-it-works\` |
| \`find-the-laws\` → \`write-law-and-proof\` → \`law-conformance\` | rules that hold for all inputs, proved in Bend, tied to shipped code | \`principle-model-the-domain\`, \`principle-type-system-discipline\` |
| \`property-test\` | fast-check over all inputs | \`principle-test-behavior-not-implementation\` (keep literal-value tests too) |
| \`add-gate\` | one write path + lint | \`correct\` level 1-2, \`principle-boundary-discipline\` |
| \`custom-lint\` | lint rule + fixture, proven by \`eng rules prove\` | \`correct\` (try architecture and types first) |
| \`e2e-flow\` | TesterArmy e2e flow + evidence per SHA | \`create-verification-skill\` (it is the Drive section) |

${cfg.laws?.enabled ? `
### Laws (Bend)
- run \`bend guide\` to learn it
- use \`${cfg.laws.laws_file}\` to keep important rules (human-owned; agents draft, ${P.approves} approves)
- run \`bend ${cfg.laws.proof_file}\` before committing (\`eng rules prove\` runs it with the planted mutations)
` : ''}
### Rule → enforcer
| Rule | Enforced by |
|---|---|
${REWRITE[rewriteMode(cfg)].rules(protectedBranches(cfg), agentGuard(cfg))}
| Merge needs a verdict from verification tooling for the exact head commit (the builder may run it): a PASS lists passing runs on its commit; a review counts only for \`verification.review_only_paths\` | \`eng verdict check\` (gate \`verdict\`) |
| No \`--no-verify\`, no admin merge (\`--admin\`) | ${bypassCell(agentGuard(cfg))} |
| Generated files match config | \`eng sync --check\` |
| Tests, e2e and fallow write only under the per-run \`$ENG_TMP\` (removed on exit, failure or signal) | \`eng gate\` / \`eng e2e\` set ENG_TMP + TMPDIR; \`eng lint\` rule \`test-bare-tmpdir\`${cfg.hygiene?.tmp_lint === false ? ' (OFF: hygiene.tmp_lint false)' : ''}; vitest globalSetup \`.eng/test-tmp.mjs\` |
| Remove your worktree when your thread settles or its PR merges; never delete unpushed or dirty ones | \`git worktree remove <path>\` without \`--force\` (git refuses a dirty worktree) |
${(cfg.constraints?.rules || []).map(r => `| ${r.id} | \`eng lint\` (proven on ${r.proven_by.incident}) |`).join('\n')}
${checkIds(cfg).map(id => `| ${id} | check \`${cfg.verification?.checks_dir ?? '.eng/checks'}/${id}.sh\`, which \`eng gate\` runs first |`).join('\n')}
${(cfg.agents?.rules || []).map(r => `| ${r.rule} | ${r.enforced_by ? (r.enforced_by === 'review' ? `reviewer judgment (${r.why || 'NO REASON: eng doctor fails'})` : `\`${r.enforced_by}\``) : '**NOTHING** (eng doctor fails)'} |`).join('\n')}
${cfg.db?.additive_only ? '| DB changes additive only | `eng lint` rule `db-additive-only` |\n' : ''}${cfg.flags?.file ? `| New flags default off | \`eng lint\` rule \`flags-default-off\` |\n` : ''}
### Branches and merge
${REWRITE[rewriteMode(cfg)].branches(cfg.project.default_branch, agentGuard(cfg), P)}
- Merge owner for this repo: **${m.owner}**. Command: \`${m.command}\`. There is no global merge rule.
- Disk hygiene: when your thread settles or its PR merges, confirm your commits are pushed (\`git status -sb\`, \`git log @{u}..\`), then run \`git worktree remove <path>\` (no \`--force\`) from the main checkout. Git refuses dirty worktrees; report unpushed or dirty ones to the repo lead. Scratch only under \`$ENG_SCRATCH\`/\`$ENG_TMP\` (\`eng run -- <cmd>\`, removed on exit), never bare /tmp; one shared cache per toolchain (\`hygiene.caches\`); containers \`--rm\` or labelled; evidence per PR; \`eng doctor\` checks the config. Clean up on merge or close: one worktree per PR reused across review rounds, evidence is logs/diffs/verdicts/screenshots only, no installs in review-only worktrees, shared package stores and build caches, media off the box. See \`SHIPPING.md\` §5.
${cfg.ship ? `- Shipping: author agents stop at merge-ready and never merge. Verification tooling gives the verdict on the head SHA; the builder may run it. Only the shipping manager (${cfg.ship.manager}) merges, reverts and reorders, one PR at a time. \`${cfg.ship.high_risk?.label || 'risk:high'}\` PRs need ${P.approves}'s approval first. See \`SHIPPING.md\` Shipping model.\n` : ''}
`;
}

// Fixed rules 16 on, in SHIPPING.md §0. The slaytek profile adds 19-21, Slaytek's own operating rules.
export function tailRules(cfg, base, s5) {
  const P = profileText(cfg);
  return `16. **A red-\`${base}\` recovery must end in either \`${base}\` green or an explicit escalation.** Escalate to the repo lead (and ${P.gated}), stating the cause, the owner and the next step. A recovery thread may never just finish while \`${base}\` is still red (${P.recovery_why}).
17. **Before reporting merge or ship status, read live state from GitHub.** PR merged?, merge SHA, \`${base}\`'s latest checks. Never report from memory or a failed command's output. ${P.live_state_why}
18. **Clean up on merge or close.** When a PR merges or closes, its worktrees and evidence are deleted. Reuse one worktree per PR, keep evidence to logs, diffs, verdicts and screenshots, share package stores and build caches, keep media off the box, and make temp dirs delete themselves (${s5}). (${P.cleanup_why[0].toUpperCase()}${P.cleanup_why.slice(1)}.)${P.slaytek_rules}`;
}

// Every shape renderAll reads without a fallback. A config missing one gets a config error naming the key and the
// template's default (eng sync, eng sync --check, eng init), never a TypeError from deep in a template string.
const RENDER_SHAPES = [
  ['project', 'mapping'], ['project.name', 'string'], ['project.default_branch', 'string'], ['project.commands', 'mapping'], ['project.commands.test', 'string'],
  ['stack', 'mapping'], ['stack.status', 'string'], ['stack.defaults', 'mapping'], ['stack.languages', 'mapping'], ['stack.languages.allowed', 'list'],
  ['stack.frameworks', 'mapping'], ['stack.frameworks.allowed', 'list'],
  ['agents', 'mapping'], ['agents.harnesses', 'list'], ['agents.skills_dir', 'string'], ['agents.skills', 'list'],
  ['gates', 'mapping'], ['gates.required', 'list'], ['merge', 'mapping'], ['merge.owner', 'string'], ['merge.command', 'string'],
];
const AUDIT_SHAPES = ['target', 'cron', 'agent_command'].map(k => [`audits.maintain_verification.${k}`, 'string']);
const SHAPE_OK = { mapping: v => !!v && typeof v === 'object' && !Array.isArray(v), list: Array.isArray, string: v => typeof v === 'string' && v.trim() !== '' };
const at = (o, keys) => keys.reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
export function renderErrors(cfg) {
  const tpl = YAML.parse(fs.readFileSync(path.join(PKG, 'templates', 'eng.config.yml'), 'utf8'));
  const shown = k => { const v = at(tpl, k.split('.')); if (v === undefined) return 'none'; const j = JSON.stringify(v); return j.length > 120 ? `${j.slice(0, 117)}...` : j; };
  const errs = [], bad = new Set();
  for (const [k, type] of [...RENDER_SHAPES, ...(cfg?.audits?.maintain_verification ? AUDIT_SHAPES : [])]) {
    const keys = k.split('.');
    if (keys.some((_, i) => bad.has(keys.slice(0, i).join('.')))) continue;
    const v = at(cfg, keys);
    if (SHAPE_OK[type](v)) continue;
    bad.add(k);
    errs.push(`${k} ${v === undefined || v === null ? 'is missing' : `must be a ${type}`}: eng sync reads it to render. The template default is ${k}: ${shown(k)}`);
  }
  return errs;
}

// .claude/skills and .claude/agents, which eng never writes into (bin/eng.mjs harnessConfigErrors). harnessRel takes a
// repo-relative path and names the folder it is at or inside; case is ignored for case-insensitive disks.
export const HARNESS_DIRS = ['.claude/skills', '.claude/agents'];
export const harnessRel = rel => { const n = path.posix.normalize(String(rel).replaceAll('\\', '/')).replace(/^(\.?\/)+/, '').replace(/\/+$/, '').toLowerCase(); return HARNESS_DIRS.find(d => n === d || n.startsWith(`${d}/`)); };
export function stackMd(cfg) {
  const s = cfg.stack, P = profileText(cfg);
  return `<!-- ${HDR('').trim()} -->
# STACK.md: ${cfg.project.name}

Status: **${s.status}**. ${P.stack_status}
These are the suggested choices. eng does not block others; record a choice outside this list in \`stack.exceptions\` with a reason.

## Defaults
| Area | Choice |
|---|---|
${Object.entries(s.defaults).map(([k, c]) => `| ${k} | ${choice(c)} |`).join('\n')}

## Allowed languages
${list(s.languages.allowed)}

## When another language is justified
${Object.entries(s.languages.justified_when || {}).map(([k, w]) => `- **${k}**: ${w}`).join('\n')}

## Allowed frameworks / libraries (checked)
${list(s.frameworks.allowed)}

## Recorded exceptions
${(s.exceptions || []).length ? s.exceptions.map(e => `- ${e.kind} \`${e.name}\`: ${e.reason} (approved by ${e.approved_by || 'PENDING'})`).join('\n') : '- none'}

## Notes
${list(s.notes)}
`;
}

export function shipLogStep(cfg) {
  return cfg.ship?.log_step ?? profileText(cfg).log_step;
}

// Shipping model (ship:). Empty when the repo has no ship: section, so older configs render unchanged.
export function shipMd(cfg) {
  const s = cfg.ship; if (!s) return '';
  const h = s.high_risk || {}, L = h.label || 'risk:high', q = s.merge_queue, P = profileText(cfg);
  return `
### Shipping model
**Roles**
- **Author:** stops at merge-ready (gate green, PR description, evidence, risk label). Never merges.
- **Verifier:** the repo's verification tooling, run on the exact commit (\`eng run --by\`), records the verdict (\`eng verdict\`), bound to the exact head SHA. Anyone may run it, the builder included.
- **Shipping manager:** ${s.manager}. The only one that merges, reverts and reorders. Never writes code.${(s.manager_also || []).length ? ` Also owns ${s.manager_also.join(' and ')}.` : ''}
- ${P.high_risk_role} \`${L}\` PRs (${(h.reasons || []).join(', ')}).${(h.paths || []).length ? ` High risk by default: ${h.paths.map(x => `\`${x}\``).join(', ')}.` : ''}${P.never_presses}

**Loop** (shipping manager, one PR at a time, run whenever a PR becomes ready)
1. Pick the oldest ready PR with a PASS verdict. Skip \`${L}\` PRs ${P.approves} has not approved yet.
2. \`gh pr update-branch <n>\`.
3. Wait for the gate on the new head. The new head needs its own run and verdict (\`eng run --by\`, then \`eng verdict\`); a verdict never carries from the old head.
4. \`gh pr merge <n> --squash --delete-branch --match-head-commit <sha>\`.
5. Confirm main is green after the merge, including the full post-merge e2e run. If anything is red (a red e2e on main above all: PR e2e is path-based, so main is the backstop), revert immediately (\`gh pr revert <n>\` or \`git revert\` in a PR), get main green again, then return the PR to its author. Do not fix forward on main.${P.main_red_ship}
6. ${shipLogStep(cfg)}

**Escalation**
- Two gate failures: back to the author with the reason.
- \`${L}\`: send it to ${P.approves} as soon as it is ready, one at a time, with a one-line summary, the evidence and the PR link. ${P.once_approved}, the shipping manager merges it.
- Red-main recovery ends only when main is green, or with an explicit escalation to the repo lead (and ${P.gated_short}) naming cause, owner and next step. Never finish while main is still red.
- Before reporting merge or ship status, read live GitHub state (PR merged?, merge SHA, main checks). Never report from memory or a failed command.
${q ? `- **Merge queue (opted in):** ${q.provider || 'github'}, max group ${q.max_group_size ?? 'small'}; CI must run on \`${q.ci_trigger || 'merge_group'}\`.\n` : ''}
TODO: fold releases and tagging into this loop (not designed yet).
`;
}

export function shippingMd(cfg) {
  const t = fillProfile(fs.readFileSync(path.join(PKG, 'templates/SHIPPING.md'), 'utf8'), cfg), P = profileText(cfg);
  const c = cfg.project.commands;
  return t.replaceAll('<REPO>', cfg.project.name)
    .replaceAll('<BASE>', cfg.project.default_branch)
    .replaceAll('<MERGE_OWNER>', cfg.merge.owner)
    .replaceAll('<MERGE_COMMAND>', cfg.merge.command)
    .replaceAll('<MERGE_METHOD>', cfg.merge.method)
    .replace('<SPAWN>', () => spawnText(cfg))
    .replace('<TAIL_RULES>', () => tailRules(cfg, cfg.project.default_branch, '§5'))
    .replace('<RULESET>', rulesetAdvice(cfg))
    .replace('<REWRITE_RULE>', () => REWRITE[rewriteMode(cfg)].shipping(agentGuard(cfg), P))
    .replace('<CI_HYGIENE>', CI_HYGIENE.map(r => `- ${r}`).join('\n'))
    .replaceAll('<FLAKE_RUNS>', String(cfg.e2e?.flake_runs ?? 3))
    .replaceAll('<GATE>', 'eng gate')
    .replaceAll('<TEST>', c.test)
    .replaceAll('<FLAGS>', cfg.flags?.file || 'none')
    .replaceAll('<MIGRATIONS>', cfg.db?.migrations || 'none')
    .replace('<!--HDR-->', `<!-- ${HDR('').trim()} -->`)
    .replace('<SHIP>', () => shipMd(cfg))
    .replace('<REFERENCE>', () => referenceText(cfg));
}

export function pipeline(cfg) {
  const g = ['checks', ...cfg.gates.required], cmd = id => id === 'checks' ? 'npx eng gate checks' : GATE_COMMANDS[id] ? `npx eng ${GATE_COMMANDS[id]}` : cfg.project.commands?.[id] ?? `echo 'no command for gate ${id}' && exit 1`;
  const steps = g.map(id => `  - label: "${id}"\n    key: "${id}"\n    command: ${JSON.stringify(cmd(id))}\n    soft_fail: false${id === 'e2e' ? `\n    artifact_paths: "${cfg.e2e?.evidence_dir ?? '.eng/evidence'}/**/*"` : ''}`).join('\n');
  return `${HDR()}
# Only main's copy of this file is ever uploaded (stored bootstrap step). soft_fail is never true: a failed or skipped step fails the build.
# e2e: ${e2ePolicyLine(cfg)}
steps:
${steps}
  - wait: ~
  - label: "required checks (skipped = failed)"
    command: ${JSON.stringify(`for k in ${g.join(' ')}; do o=$$(buildkite-agent step get outcome --step "$$k"); [ "$$o" = passed ] || { echo "$$k: $$o"; exit 1; }; done`)}
`;
}

export function e2ePolicyLine(cfg) {
  const p = resolvePolicy(cfg.e2e);
  if (p.mode === 'always') return 'runs on every PR and on main (e2e.policy.mode: always).';
  return `PRs run it only when they touch ${Object.keys(p.run_on).join(', ')} paths or carry ${p.labels.join(', ')}; docs-only, config-only (non-CI) and test-only PRs pass as NOT REQUIRED (\`eng e2e --required\` explains why). main runs the full suite after every merge${p.main.nightly.enabled ? ' and nightly' : ''}; red on main = revert now.`;
}
// Nightly full e2e (backstop). Rendered only when e2e.policy.main.nightly.enabled. eng never creates schedules.
export function e2eNightlyPipeline(cfg) {
  const n = resolvePolicy(cfg.e2e).main.nightly;
  return `${HDR()}
# Nightly full e2e on ${cfg.project.default_branch} (backstop). Create the schedule in Buildkite (Pipeline Settings > Schedules,
# cron "${n.cron}", branch ${cfg.project.default_branch}) pointing at this file. A red run = shipping manager reverts the culprit.
steps:
  - label: "eng e2e (nightly, full)"
    key: "e2e-nightly"
    command: "npx eng e2e --if-required"
    env:
      ENG_E2E_EVENT: nightly
    soft_fail: false
    artifact_paths: "${cfg.e2e?.evidence_dir ?? '.eng/evidence'}/**/*"
`;
}

// Daily maintain-verification audit as a scheduled pipeline (Buildkite pipeline schedule points at this file).
// Defined here; no schedule is created by eng. The step hands the vendored skill to a headless agent.
export function auditPipeline(cfg) {
  const a = cfg.audits.maintain_verification;
  return `${HDR()}
# Daily audit: pstack maintain-verification-skill, unchanged. Create the schedule in Buildkite (Pipeline Settings > Schedules,
# cron "${a.cron}") pointing at this file. eng never creates schedules. Outcome: clean (no PR) / changed (one PR) / blocked.
steps:
  - label: "audit: maintain-verification-skill (${a.target})"
    key: "audit-maintain-verification"
    command: |
      ${a.agent_command.replaceAll('{skill}', `${cfg.agents.skills_dir}/maintain-verification-skill/SKILL.md`).replaceAll('{target}', a.target)}
    soft_fail: false
    artifact_paths: "${cfg.e2e?.evidence_dir ?? '.eng/evidence'}/**/*"
`;
}
const ENG_CHECKS = '\$ENG sync --check && \$ENG lint';
const shQuote = (cmd) => `'${cmd.replaceAll("'", "'\\''")}'`;
// With extra commands, each one runs in its own shell so its operators cannot skip or mask the eng checks.
function preCommitBody(extra) {
  if (!extra.length) return ENG_CHECKS;
  return [`${ENG_CHECKS} || exit $?`, ...extra.map(cmd => `sh -c ${shQuote(cmd)} || exit $?`)].join('\n');
}
// hooks.pre_push: git hands pre-push its ref lines on stdin once, so the hook keeps them in a private file and replays the
// same bytes to eng's checks and then to each command, in order, with the hook's own arguments (remote name, URL).
function prePushBody(checks, extra) {
  if (!extra.length) return `${checks}\nexit 0\n`;
  // PR #56 verdict 1: no temp file, so no signal can leave one behind. The ref lines are text (no NUL), so they fit in a
  // variable; the trailing '.' keeps any trailing newlines that command substitution would strip, and an empty stdin
  // stays empty. eng's checks read them in a subshell and refuse with its exit status; no command runs after a refusal.
  const run = (cmd, i) => `printf '%s' "$in" | sh -c ${shQuote(cmd)} "$0" "$@" || { s=$?; printf 'eng: hooks.pre_push command %s of %s failed (exit %s): %s\\n' ${i + 1} ${extra.length} "$s" ${shQuote(cmd)} >&2; exit "$s"; }`;
  // PR #56 verdict 2: the '.' is printed only when cat succeeds, so a failed, partial or interrupted read fails the push.
  return `in=$(cat && printf .) || exit 1
case $in in *.) in=\${in%.} ;; *) exit 1 ;; esac
printf '%s' "$in" | (
${checks}
exit 0
) || exit $?
${extra.map(run).join('\n')}
exit 0
`;
}
export function hooks(cfg) {
  const P = profileText(cfg), prot = protectedBranches(cfg), never = rewriteMode(cfg) === 'never', prePush = cfg.hooks?.pre_push ?? [];
  const isProt = `case "$b" in ${prot.map(p => `'${p}'`).join('|')}) prot=1 ;; *) prot= ;; esac`;
  return {
    '.githooks/pre-rebase': `#!/bin/sh
${HDR()}
${never
    ? `# git.rewrite_pushed: never. Protected branches are never rebased. On a feature branch, rebase only commits that were never
# pushed: a rebase that would rewrite a commit already on the branch's upstream is refused, and .githooks/pre-push refuses
# a non-fast-forward push to any branch.`
    : `# git.rewrite_pushed: protected. Protected branches are never rebased. Feature branches may be rebased; a pushed one is
# republished only through the repo's guarded tool (for example Graphite's gt submit).`}
b=\${2:-$(git rev-parse --abbrev-ref HEAD)}
${isProt}
[ -n "$prot" ] && { echo "eng: rebasing protected branch $b is blocked: its history is never rewritten. To update it, git pull --ff-only; to change it, open a pull request" >&2; exit 1; }
${never ? `u=$(git rev-parse -q --verify "$b@{upstream}" 2>/dev/null) || exit 0
m=$(git merge-base "refs/heads/$b" "$u" 2>/dev/null) || exit 0
n=$(git rev-list --count \${1:+"^$1"} "$m")
[ "$n" -gt 0 ] && { echo "eng: rebasing $b would rewrite $n commit(s) already pushed to $(git rev-parse --abbrev-ref "$b@{upstream}"); pushed history is never rewritten (git.rewrite_pushed: never). Add a commit instead; to bring in the base, merge it (gh pr update-branch)" >&2; exit 1; }
` : ''}exit 0
`,
    '.githooks/pre-push': `#!/bin/sh
${HDR()}
${never
    ? `# git.rewrite_pushed: never${P.never_note}. Blocks a non-fast-forward push to ANY branch, moving or deleting a pushed
# tag, and deleting a protected branch (${prot.join(', ')}). Fix with a new commit; bring in the base with a merge
# (gh pr update-branch). A server ruleset is the real wall for protected branches.`
    : `# git.rewrite_pushed: protected${P.protected_note}. Blocks a non-fast-forward push to or deletion of a protected branch
# (${prot.join(', ')}) and moving or deleting a pushed tag. Feature branches may be rewritten through the repo's guarded
# tool. A server ruleset is the real wall for protected branches.`}
${prePush.length ? `# Then each hooks.pre_push command runs in order, in its own sh -c, with this hook's arguments and the same ref lines on
# stdin. The push stops at the first failure; when eng's checks refuse, no command runs. git push --no-verify skips
# this whole hook.
` : ''}${prePushBody(`z=0000000000000000000000000000000000000000
while read lref lsha rref rsha; do
  [ "$rsha" = "$z" ] && continue
  case "$rref" in
    refs/tags/*) echo "eng: $rref is already pushed; a pushed tag never moves or is deleted. Cut a new tag instead" >&2; exit 1 ;;
    refs/heads/*)
      b=\${rref#refs/heads/}
      ${isProt}
      if [ "$lsha" = "$z" ]; then
        [ -n "$prot" ] && { echo "eng: deleting protected branch $b is blocked" >&2; exit 1; }
        continue
      fi
      ${never ? '' : '[ -n "$prot" ] || continue\n      '}if ! git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null; then
        case "$lref" in refs/heads/*) on="git switch \${lref#refs/heads/}"; src=$lref ;; *) on="git switch --detach $lsha"; src='$(git rev-parse HEAD)' ;; esac
        echo "eng: non-fast-forward push to $b blocked: ${never ? 'pushed history is never rewritten (git.rewrite_pushed: never)' : 'protected history is never rewritten'}. Add a commit instead; to bring in the base, merge it (gh pr update-branch). To keep your work and what is already on $b: git fetch $1 $rref, then $on, then git merge $rsha (resolve any conflicts), then git push $1 $src:$rref" >&2; exit 1
      fi ;;
  esac
done`, prePush)}`,
    '.githooks/pre-commit': `#!/bin/sh
${HDR()}
# The installed eng runs with node, so npm never resolves the project (npx fails on overrides npm rejects). Set ENG to override.
[ -f ${LOCAL_ENG} ] && d="node ${LOCAL_ENG}" || d="npx --no-install eng"
ENG="\${ENG:-$d}"
${preCommitBody(cfg.hooks?.pre_commit ?? [])}
`,
  };
}

// Claude Code Bash rules (code.claude.com/docs/en/permissions, Wildcard patterns): `*` matches any text, spaces included,
// anywhere in the rule, and a trailing ` *` also matches the bare command. So each token is denied in every position
// after `git push`, and after `git -<global options> push`.
const PUSH = ['git push', 'git -* push'];
// Every way `toks` can sit, in order, among the other words of a push.
const among = (...toks) => toks.reduce((acc, t, i) => acc.flatMap(a => i ? [`${a} ${t}`, `${a} * ${t}`] : [t, `* ${t}`]), ['']).flatMap(a => [a, `${a} *`]);
export function claudeSettings(cfg) {
  const prot = protectedBranches(cfg);
  // Substrings cover --force-with-lease[=...] and --force-if-includes; `+` is a forced refspec.
  const tails = ['*--force*', '*--mirror*', '*--no-verify*', '+*', '* +*', ...['-f', '-uf', '-fu'].flatMap(f => among(f)),
    ...prot.flatMap(b => [...among('--delete', b), ...among('-d', b), ...among(`:${b}`), ...among(`:refs/heads/${b}`)])];
  const deny = [...PUSH.flatMap(p => tails.map(t => `Bash(${p} ${t})`)), ...['git commit --no-verify', 'git commit -n', 'git merge --no-verify', 'gh pr merge --admin'].map(d => `Bash(${d}:*)`)];
  const postEdit = cfg.agents?.post_edit_command;
  const hooks = postEdit ? { hooks: { PostToolUse: [{ matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: postEdit, timeout: 60 }] }] } } : {};
  return JSON.stringify({ permissions: { deny: [...new Set(deny)] }, ...hooks }, null, 2) + '\n';
}

export function prTemplate() {
  return `<!-- ${HDR('').trim()} -->
## What and why

## Evidence
<!-- eng run --by output on the exact head SHA (fails on base, passes on HEAD) and the eng verdict it backs -->

## E2E / taste evidence
<!-- TesterArmy run link, video, screenshots -->

## Merge Danger
- Door: one-way / two-way
- Blast radius:

## Rollback
<!-- flag off first; DB is forward-fix only -->

## TesterArmy testing instructions
`;
}

// A vendored source keeps upstream layout: <src>/<name>, <src>/skills/<name>, or <src>/automations/*/skills/<name>.
function skillDir(src, name) {
  if (src === 'eng') { const d = path.join(PKG, 'skills', name); return fs.existsSync(d) ? d : null; }
  const base = path.join(PKG, 'vendor', src);
  const autos = fs.existsSync(path.join(base, 'automations')) ? fs.readdirSync(path.join(base, 'automations')).map(a => path.join(base, 'automations', a, 'skills', name)) : [];
  return [path.join(base, name), path.join(base, 'skills', name), ...autos].find(d => fs.existsSync(path.join(d, 'SKILL.md'))) ?? null;
}
// `<src>/*` installs every skill the source ships (pstack: skills/ and automations/*/skills/).
export function expandSkills(cfg) {
  return cfg.agents.skills.flatMap(s => {
    const [src, name] = s.split('/');
    if (name !== '*') return [s];
    const base = path.join(PKG, 'vendor', src), dirs = [path.join(base, 'skills')];
    if (fs.existsSync(path.join(base, 'automations'))) for (const a of fs.readdirSync(path.join(base, 'automations'))) dirs.push(path.join(base, 'automations', a, 'skills'));
    return dirs.filter(d => fs.existsSync(d)).flatMap(d => fs.readdirSync(d).filter(n => fs.existsSync(path.join(d, n, 'SKILL.md')))).sort().map(n => `${src}/${n}`);
  });
}

// skills: vendored (pinned upstream, path-rewritten) + ours
// exec collects the output paths whose vendored source is executable (statechart's scripts/statechart runner).
export function skills(cfg, exec = new Set()) {
  const out = {};
  let rewrite = t => t;
  const add = (srcDir, name) => {
    const walk = (d, rel = '') => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name), r = path.join(rel, f.name);
        if (f.isDirectory()) walk(p, r);
        else if (f.name !== 'LICENSE') {
          const o = `${cfg.agents.skills_dir}/${name}/${r}`;
          out[o] = rewrite(fs.readFileSync(p, 'utf8'));
          if (fs.statSync(p).mode & 0o111) exec.add(o);
        }
      }
    };
    walk(srcDir);
  };
  for (const s of expandSkills(cfg)) {
    const [src, name] = s.split('/');
    const dir = skillDir(src, name);
    if (!dir) throw new Error(`unknown skill ${s}`);
    const rw = path.join(PKG, 'vendor', src, 'REWRITES.tsv');
    const pairs = src !== 'eng' && fs.existsSync(rw) ? fs.readFileSync(rw, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t').map(x => x.replaceAll('{skills_dir}', cfg.agents.skills_dir))) : [];
    rewrite = src === 'eng' ? t => fillProfile(t, cfg) : t => pairs.reduce((a, [f, to]) => a.replaceAll(f, to), t);
    add(dir, name);
    // Codex ignores disable-model-invocation; its switch is agents/openai.yaml policy.allow_implicit_invocation (developers.openai.com/codex/skills).
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), fm = md.startsWith('---') ? md.split('---')[1] : '';
    const oy = `${cfg.agents.skills_dir}/${name}/agents/openai.yaml`;
    if (cfg.agents.harnesses.includes('codex') && /^disable-model-invocation:\s*true\s*$/m.test(fm) && !out[oy]) out[oy] = 'policy:\n  allow_implicit_invocation: false\n';
  }
  // A whole-source install also brings its subagent definitions (pstack: poteto-agent, Comment Sicko).
  for (const src of cfg.agents.skills.filter(s => s.endsWith('/*')).map(s => s.split('/')[0])) {
    const ad = path.join(PKG, 'vendor', src, 'agents');
    if (fs.existsSync(ad)) for (const f of fs.readdirSync(ad)) out[`${path.dirname(cfg.agents.skills_dir)}/agents/${f}`] = fs.readFileSync(path.join(ad, f), 'utf8');
  }
  return out;
}

// Vitest globalSetup (and any test/e2e runner hook): every test write goes under one per-run dir, removed at teardown.
export function testTmp(cfg) {
  const pre = `eng-${String(cfg.project.name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'}-`;
  return `${HDR('//')}
// Per-run temp dir for tests. Wire it once in vitest.config.* (and vitest.*.config.*):
//   test: { globalSetup: ['./.eng/test-tmp.mjs'] }
// Under \`eng gate\` / \`eng e2e\`, ENG_TMP and TMPDIR already point at a dir eng removes on exit (also on failure or signal);
// run directly (\`vp test\`), this creates one and removes it at teardown. Tests write only under process.env.ENG_TMP:
//   fs.mkdtempSync(path.join(process.env.ENG_TMP, 'x-'))   // never bare os.tmpdir() (eng lint rule test-bare-tmpdir)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup() {
  if (process.env.ENG_TMP && fs.existsSync(process.env.ENG_TMP)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), \`${pre}\${Date.now().toString(36)}-\${process.pid}-\`));
  process.env.ENG_TMP = dir; process.env.TMPDIR = dir;
  const rm = () => fs.rmSync(dir, { recursive: true, force: true });
  process.once('exit', rm);
  return rm;
}
`;
}

// Generated paths that must be executable: git hooks and vendored scripts. eng sync sets the bit; eng sync --check checks it.
export function executables(cfg) {
  const exec = new Set(Object.keys(hooks(cfg)));
  skills(cfg, exec);
  return exec;
}

export function renderAll(cfg, existingAgents, existingShipping = null) {
  const files = {
    'STACK.md': stackMd(cfg),
    // A repo that adopted the standard while shipping (renovation:) keeps its stricter local rules in SHIPPING.md.
    'SHIPPING.md': cfg.renovation ? withLocalRules(shippingMd(cfg), existingShipping) : shippingMd(cfg),
    ...(cfg.renovation ? { 'renovation/divergences.md': divergencesMd(cfg) } : {}),
    'CLAUDE.md': '@AGENTS.md\n',
    '.github/pull_request_template.md': prTemplate(),
    '.eng/ci/pipeline.yml': pipeline(cfg),
    ...(cfg.audits?.maintain_verification ? { '.eng/ci/audit.yml': auditPipeline(cfg) } : {}),
    ...(cfg.e2e && resolvePolicy(cfg.e2e).main.nightly.enabled ? { '.eng/ci/e2e-nightly.yml': e2eNightlyPipeline(cfg) } : {}),
    '.eng/test-tmp.mjs': testTmp(cfg),
    // The checks dir is always tracked, so eng gate can tell a repo with no checks from a moved or missing dir.
    [`${cfg.verification?.checks_dir ?? '.eng/checks'}/.gitkeep`]: '',
    ...(cfg.models?.pstack ? { '.eng/pstack-models.md': pstackModels(cfg, HDR()) } : {}),
    ...hooks(cfg),
    ...skills(cfg),
  };
  if (cfg.agents.harnesses.includes('claude-code')) files['.claude/settings.json'] = claudeSettings(cfg);
  // AGENTS.md: only the block is ours; text outside belongs to people.
  const block = agentsBlock(cfg);
  let a = existingAgents ?? `# AGENTS.md\n\n${block}\n`;
  if (a.includes(BEGIN) && a.includes(END)) a = a.slice(0, a.indexOf(BEGIN)) + block + a.slice(a.indexOf(END) + END.length);
  else a = a.trimEnd() + '\n\n' + block + '\n';
  files['AGENTS.md'] = a;
  return files;
}

// ---------- SHIPPING.md local rules and divergences (a repo that adopted the standard while shipping) ----------
export const LOCAL_BEGIN = '<!-- renovation:local -->', LOCAL_END = '<!-- renovation:local:end -->';
// A pre-existing SHIPPING.md without the markers is kept whole as local rules (even a generated one with local edits), so no
// stricter rule is lost; the lead trims it. Only an exact plain render of the template starts with an empty local block.
export function withLocalRules(rendered, existing) {
  let keep = '\n';
  if (existing?.includes(LOCAL_BEGIN) && existing.includes(LOCAL_END)) keep = existing.slice(existing.indexOf(LOCAL_BEGIN) + LOCAL_BEGIN.length, existing.indexOf(LOCAL_END));
  else if (existing?.trim() && existing.trimEnd() !== rendered.trimEnd()) keep = `\n${existing.trim()}\n`;
  return `${rendered.trimEnd()}\n\n${PRINCIPLES_LINE}\n\n## 8. Local rules (kept by eng sync)\n\nStricter rules this repo keeps on top of the standard live between the markers below; \`eng sync\` never rewrites them. Each one is listed in renovation/divergences.md.\n\n${LOCAL_BEGIN}${keep}${LOCAL_END}\n`;
}
export function divergences(cfg) {
  const r = cfg.renovation || {}, out = [...(r.divergences || [])];
  if (r.merge_policy?.strict === true) out.unshift({ rule: 'Required checks strictness', standard: 'not strict (SHIPPING.md §2): branches need not be up to date', local: 'strict: branches must be up to date before merge', reason: r.merge_policy.reason || 'set by the repo lead', owner: r.policy_owner });
  return out;
}
export function divergencesMd(cfg) {
  const d = divergences(cfg), esc = x => String(x ?? '').replaceAll('|', '\\|');
  return `# Divergences from the eng-standard\n\nGenerated by \`eng sync\` from eng.config.yml (renovation.merge_policy, renovation.divergences). Each row is a local rule that is stricter than, or different from, the standard. The policy owner approves each row.\n\n` +
    (d.length ? `| Rule | Standard | This repo | Reason | Owner |\n|---|---|---|---|---|\n${d.map(x => `| ${esc(x.rule)} | ${esc(x.standard)} | ${esc(x.local)} | ${esc(x.reason)} | ${esc(x.owner)} |`).join('\n')}\n` : 'None. This repo follows the standard as rendered.\n');
}
