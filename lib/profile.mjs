// profile: which organisation's operating rules the rendered files carry. eng-standard is public, so the default
// (generic) names no person, company, tool or private note: a role is the repo owner (project.owner), and a rule carries
// its reason instead of who approved it when. `profile: slaytek` restores Slaytek Systems' text byte for byte (the
// v0.17.2 output; test/profile.test.mjs proves it), including the rules only Slaytek runs: briefs in Core, the T3
// callback contract and hand-off by default.
//
// TEXT holds every fragment that differs. Both profiles have the same keys (test/profile.test.mjs). A value is a string,
// with {owner} filled from ownerOf.
export const PROFILES = ['generic', 'slaytek'];
export const profileOf = cfg => cfg?.profile ?? 'generic';
export const ownerOf = cfg => cfg?.project?.owner ?? (profileOf(cfg) === 'slaytek' ? 'Matt' : 'the repo owner');

// Printed by eng sync and eng doctor while a config has no profile line. eng never adds it: a config may belong to
// someone outside Slaytek.
export const PROFILE_NOTICE = 'eng: Slaytek Systems rules (Matt, Core, T3) are now opt-in. To keep them, add `profile: slaytek` to eng.config.yml; to hide this line, add `profile: generic`.';
export const needsProfileNotice = cfg => !!cfg && typeof cfg === 'object' && !('profile' in cfg);

export function profileErrors(cfg) {
  const errs = [];
  if (cfg && 'profile' in cfg && !PROFILES.includes(cfg.profile)) errs.push(`profile must be ${PROFILES.join(' or ')} (got ${JSON.stringify(cfg.profile)})`);
  const o = cfg?.project?.owner;
  if (o !== undefined && !(typeof o === 'string' && o.trim() && !/[\r\n]/.test(o))) errs.push('project.owner must be one line naming who approves for this repo (a name, @handle or role)');
  return errs;
}

// Slaytek's persist markers. devbox-ops docker-ephemeral keeps containers labelled slaytek.persist=true, so both markers
// count in every profile, whatever hygiene.run_rules.ephemeral_runs says.
export const SLAYTEK_PERSIST = { label: 'slaytek.persist=true', env: 'SLAYTEK_PERSIST=true' };
export const GENERIC_PERSIST = { label: 'eng.persist=true', env: 'ENG_PERSIST=true' };
export const persistDefaults = cfg => profileOf(cfg) === 'slaytek' ? SLAYTEK_PERSIST : GENERIC_PERSIST;

// The Core note 'Model routing: who uses which model'. Slaytek's default for models.routing; generic has none.
export const SLAYTEK_ROUTING = 'core:nd77rx5dhdt899w2np5kjknqdd8g8y2d';
export const routingOf = cfg => cfg?.models?.routing ?? (profileOf(cfg) === 'slaytek' ? SLAYTEK_ROUTING : null);

const TEXT = {
  slaytek: {
    standard_title: 'Slaytek Systems engineering standard',
    company_line: 'Company name: Slaytek Systems (never "Slaytek" alone).\n',
    fixed_scope: 'same in every Slaytek Systems repo; do not edit per repo',
    never_by: 'Matt, 3 Nov 2026; ',
    never_why: '',
    protected_by: 'Matt, 8 Nov 2026; ',
    never_note: ' (Matt, 3 Nov 2026)',
    protected_note: ' (Matt, 8 Nov 2026)',
    bypass_guard: ' The devbox Safe YOLO hook blocks `gh pr merge --admin` as `production.mutate`.',
    builder_may: 'the builder may verify its own work (Matt, 6 Nov 2026)',
    verdict_exact: ' (PR #42 review, 6 Nov 2026)',
    flake_why: ' (motus MOT-338, 13 Oct 2026)',
    main_red_why: ' (motus #285, 13 Oct 2026)',
    verification_by: ' (Matt, 6 Nov 2026)',
    disk_title: 'Disk hygiene (devbox disk hit 92%, 13 Oct 2026)',
    disk_story: 'The shared devbox filled at ~8 GB/hour: per-run test dirs in /tmp were never deleted (Motus vitest/e2e 2-4 GB per run, 44 GB in total; Core Edge fallow-coverage/cli-home fixtures ~8 GB; a stray 34 GB /tmp/node_modules) and 118 T3 worktrees (~70 GB) were never removed when their threads finished.',
    cleanup_why: 'devbox forensics, 17 Oct 2026: about 100 GB of agent leftovers',
    scratch_why: "v0.9.2; Warden's audit, Oct 2026: a motus proof script's mkdtemp in /tmp, Core Edge Rust targets in /tmp, equitus Deno caches per run, Docker anonymous volumes",
    ephemeral_why: "Matt, 30 Oct 2026; PR 865's review scripts left 17 exited containers and about 8 GB of volumes with the disk at 92%",
    sandbox: 'a Boat sandbox',
    persist_marks: 'a container with the label `slaytek.persist=true` or a restart policy (`--restart unless-stopped`; devbox-ops docker-ephemeral keeps the same two), or `SLAYTEK_PERSIST=true` in the server\'s environment',
    disk_rules_by: ' (approved by Matt, 30 Oct 2026; source: Core note nd79fdwd1p4hc5nk60j7rmbn518h6tsv). The 29 Oct disk audit',
    steer_example: ' (e.g. T3)',
    steer_example_skill: ' (for example in T3)',
    gated: 'Matt if the change is Matt-gated',
    gated_short: 'Matt if Matt-gated',
    recovery_why: 'Motus f193b345, 14 Oct 2026: two recovery threads ended with main still red',
    live_state_why: '(Core Edge #257, 14 Oct 2026: a thread reported "no merge SHA yet" when the PR had merged at 5:28 AM AEDT as ec67f831.)',
    slaytek_rules: `
19. **Briefs live in Core.** Any brief one agent hands another (a builder, reviewer or verifier thread) is written to Core first, as a note in the repo's Core space tagged \`brief\`. The worker thread's prompt names the Core note id; it may paste the brief inline too. \`/tmp\` or any other scratch path is never the only copy; a local file is only a convenience copy of the Core note. A revision updates the same note (Core keeps the history); never create a second note such as r2. (Approved by Matt, 19 Oct 2026: verdicts and audits must see exactly what a builder was told, even after the devbox restarts or \`/tmp\` is cleaned.)
20. **Callback contract.** Scripts, CI jobs and T3 threads that wake a bot post only when work is done, blocked or needs a decision. No progress pings, no all-clears. The post is one line: \`<status> <thread-id> <one short clause>\`, where status is \`done\`, \`blocked\` or \`needs-decision\`. Detail goes in a Core note or file, named by its id. A woken bot reads only that payload and at most the last 2 messages of the named thread, never the whole history. If nothing needs a decision or reply, it exits without a message. (Approved by Matt, 19 Oct 2026.)
21. **Hand off by default.** Any coding or bulk job over about 20 steps goes to a T3 thread: a builder, whose change verification tooling runs on the exact commit before merge (the builder may run it). The lead hands it off and ends its own run, then wakes on the rule-20 \`done\` or \`blocked\` callback. Leads check progress with cheap live-state checks (the verdict status, CI, \`gh pr checks\`, \`gh pr view\`), not by reading whole threads or diffs. Decisions for Matt and client-facing communication stay with the lead. (Approved by Matt, 19 Oct 2026. Tested first on Eng Manager's Fleet Control Tower webhook from 19 Oct; project leads switch on Wed 21 Oct 2026.)`,
    stack_status: 'Every choice below is a draft decision for Matt until marked APPROVED in eng.config.yml.',
    log_step: "Log the merge on the PR's Core task (PR number, merge SHA, main's post-merge result). Record any decision as its own decision note. Never write to the repo's Core status note.",
    approves: 'Matt',
    once_approved: 'Once he approves',
    merge_once: 'merge once he approves',
    main_red_ship: ' (motus #285, 13 Oct 2026: red post-merge e2e on main, reverted at once.)',
    high_risk_role: '**Matt:** only approves',
    never_presses: ' Matt never presses merge.',
    t3_send_rule: 'A `queued` result from `t3_thread_send` confirms only that T3 stored the message. Confirm that a new run started with `t3_thread_read` activity or `t3_thread_wait`. Use `mode: "auto"` for time-critical or approved sends, then confirm the run started.',
  },
  generic: {
    standard_title: 'Engineering standard',
    company_line: '',
    fixed_scope: 'same in every repo that uses eng; do not edit per repo',
    never_by: '',
    never_why: ' A rewrite can drop commits someone else already built on, and a verdict counts only for the exact commit it ran on, so a rewritten head loses its evidence.',
    protected_by: '',
    never_note: '',
    protected_note: '',
    bypass_guard: '',
    builder_may: 'the builder may verify its own work, because the recorded runs are the evidence, not who ran them',
    verdict_exact: '',
    flake_why: ': a re-run until green hides real failures',
    main_red_why: ': every later merge would build on the break',
    verification_by: ', because only a run shows the code works; reading a diff does not',
    disk_title: 'Disk hygiene (a shared machine\'s disk once hit 92%)',
    disk_story: 'A shared machine filled at about 8 GB an hour: per-run test dirs in /tmp were never deleted (2-4 GB per test or e2e run, 44 GB in one repo; a stray 34 GB /tmp/node_modules) and 118 agent worktrees (about 70 GB) were never removed when their threads finished.',
    cleanup_why: 'agent leftovers once took about 100 GB of a shared machine',
    scratch_why: 'v0.9.2; an audit found a proof script\'s mkdtemp in /tmp, Rust targets in /tmp, Deno caches per run and Docker anonymous volumes',
    ephemeral_why: 'review scripts once left 17 exited containers and about 8 GB of volumes with the disk at 92%',
    sandbox: 'a throwaway sandbox',
    persist_marks: 'a container with the label `eng.persist=true` or a restart policy (`--restart unless-stopped`), or `ENG_PERSIST=true` in the server\'s environment',
    disk_rules_by: '. A disk audit',
    steer_example: '',
    steer_example_skill: '',
    gated: '{owner} if the change needs their approval',
    gated_short: '{owner} if it needs their approval',
    recovery_why: 'two recovery threads once ended with main still red',
    live_state_why: '(A thread once reported "no merge SHA yet" for a PR that had already merged.)',
    slaytek_rules: '',
    stack_status: 'Each choice below is a recommendation with its reason, for {owner} to adopt or replace. In eng.config.yml a decision is DRAFT (not decided yet), APPROVED (adopted) or IN USE (already in place).',
    log_step: "Record the merge where this repo tracks its work (PR number, merge SHA, main's post-merge result), and any decision as its own record.",
    approves: '{owner}',
    once_approved: 'Once {owner} approves',
    merge_once: 'merge once {owner} approves',
    main_red_ship: ' Every later merge would build on the break.',
    high_risk_role: '**Repo owner:** only approves',
    never_presses: ' The owner never presses merge.',
    t3_send_rule: '',
  },
};

export function profileText(cfg) {
  const owner = ownerOf(cfg), t = Object.fromEntries(Object.entries(TEXT[profileOf(cfg)]).map(([k, v]) => [k, v.replaceAll('{owner}', owner)]));
  return { ...t, Approves: t.approves[0].toUpperCase() + t.approves.slice(1) };
}
// What a PASS proves. Always shown: an App ID only names who posts a status, and no merge path re-runs commands.
// The AGENTS.md block has a word budget, so it carries the short form; SHIPPING.md and eng doctor carry the full line.
export const PASS_PROVES = 'A verification PASS proves a recorded run on the exact commit, not a re-run at merge time. A review PASS on docs-only changes has no runs.';
export const PASS_PROVES_SHORT = 'A verification PASS is a recorded run, not a re-run. Review PASS: no runs.';
export const PROFILE_KEYS = Object.fromEntries(Object.entries(TEXT).map(([p, t]) => [p, Object.keys(t)]));
// Fills {{key}} in a template or in one of eng's own skills.
export const fillProfile = (text, cfg) => { const t = profileText(cfg); return text.replace(/\{\{(\w+)\}\}/g, (m, k) => k in t ? t[k] : m); };
