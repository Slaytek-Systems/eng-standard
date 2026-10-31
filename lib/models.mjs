// models: which model does which job. The standard names no models: AGENTS.md points to the routing note in Core, and
// the only concrete picks a repo can make live under models.pstack in eng.config.yml (rendered to .eng/pstack-models.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Core note 'Model routing: who uses which model'. Matt edits the routing there; nothing here copies it.
export const ROUTING = 'core:nd77rx5dhdt899w2np5kjknqdd8g8y2d';
const KEYS = ['routing', 'pstack'];

// pstack's role labels, read from the role lines in setup-pstack step 5 so a pstack bump brings its own list.
export function pstackRoles() {
  const md = fs.readFileSync(path.join(PKG, 'vendor/pstack/skills/setup-pstack/SKILL.md'), 'utf8');
  const step = md.slice(md.indexOf('### 5. Write the rule'), md.indexOf('### 6.'));
  const at = step.indexOf('\n# budget:'), block = step.slice(at + 1, step.indexOf('```', at));
  return block.split('\n').slice(1).filter(Boolean).map(l => l.slice(0, l.indexOf(': ')));
}

// One line each: a line break would render as an extra role line in .eng/pstack-models.md.
const line = x => typeof x === 'string' && x.trim() !== '' && !/[\r\n]/.test(x);
const pick = v => line(v) || (Array.isArray(v) && v.length > 0 && v.every(line));

export function modelErrors(m) {
  if (m === undefined) return [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [`models must be a mapping (${KEYS.join(', ')})`];
  const errs = Object.keys(m).filter(k => !KEYS.includes(k)).map(k => `models.${k} is not a setting (${KEYS.join(', ')})`);
  if ('routing' in m && !line(m.routing)) errs.push('models.routing must be one line, a non-empty string (a Core note id)');
  const p = m.pstack;
  if (p === undefined) return errs;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [...errs, 'models.pstack must be a mapping of pstack role to model'];
  const roles = pstackRoles();
  for (const [r, v] of Object.entries(p)) {
    if (!roles.includes(r)) errs.push(`models.pstack."${r}" is not a pstack role (${roles.join('; ')})`);
    else if (!pick(v)) errs.push(`models.pstack."${r}" must be a model, inherit-parent, auto, or a non-empty list of them`);
  }
  return errs;
}

export function modelsText(m) {
  const pstack = m?.pstack
    ? 'pstack role lines are in `.eng/pstack-models.md` (from `models.pstack` in eng.config.yml). Read it where a pstack skill names the `pstack-models` rule; a role with no line keeps the skill default.'
    : 'pstack skills name their own default models. To set a role, add it under `models.pstack` in eng.config.yml (eng sync renders `.eng/pstack-models.md`).';
  return `- Models: this standard names no models. Which model or provider does which job is set in the Core note 'Model routing: who uses which model' (\`${m?.routing ?? ROUTING}\`). Read it before you pick a model for a subagent, reviewer or delegated task. It wins over any default in a skill and over \`models.pstack\`. ${pstack}`;
}

// .eng/pstack-models.md, in the shape setup-pstack writes. Only rendered when models.pstack is set.
export function pstackModels(m, hdr) {
  return `${hdr}
# pstack model configuration (models.pstack). One line per role. A role with no line keeps the skill default.
# \`inherit-parent\` or \`auto\` as a value: the role runs on the parent chat model (omit Task \`model\`).
# Routing source: ${m.routing ?? ROUTING}. It wins over these lines.
${Object.entries(m.pstack).map(([r, v]) => `${r}: ${[v].flat().join(', ')}`).join('\n')}
`;
}

// A model id or a versioned model name. The guard covers these forms of a listed family:
// - FAMILY (a word that only names models) joined by a hyphen to anything, unless the rest is a tool word plus letters
//   only (TOOL: claude-code, codex-cli, grok-notify are harnesses) or a build target (ARCH: a release download).
// - FAMILY tagged with a colon (the Ollama form), or with a version glued on.
// - FAMILY or WORD (a word with an everyday meaning, which counts only with a version) and a spaced version: 5, v4, k3, r1.
// - a bare o-series id, and a route through the opencode Go provider.
// A family not listed here, or a name with words between family and version, is out of reach: add the family word.
// A miss is silent and a false positive fails loudly, so the guard leans to flagging.
// Outside eng.config.yml files, vendored upstream text and history, the repo must not contain one (test/models.test.mjs).
const FAMILY = ['claude', 'chatgpt', 'gpt', 'grok', 'gemini', 'gemma', 'deepseek', 'glm', 'kimi', 'moonshot', 'mimo', 'qwen', 'qwq', 'llama', 'mistral',
  'mixtral', 'codestral', 'ministral', 'magistral', 'devstral', 'pixtral', 'codex'].join('|');
const WORD = ['opus', 'sonnet', 'haiku', 'fable', 'composer', 'phi'].join('|');
const TOOL = ['code', 'cli', 'rs', 'agent', 'agents', 'plugin', 'plugins', 'bot', 'notify', 'settings', 'sdk', 'mcp', 'cpp', 'index', 'desktop', 'app',
  'skills', 'config', 'md', 'json', 'router', 'proxy', 'sessions', 'only'].join('|');
const ARCH = ['x86_64', 'aarch64', 'arm64', 'amd64', 'linux', 'darwin', 'windows', 'macos'].join('|');
export const MODEL_ID = new RegExp([
  `\\b(?:${FAMILY})-(?!(?:${TOOL})(?:-[a-z]+)*(?![\\w-]|\\.\\d)|(?:${ARCH})\\b)[a-z0-9]`,
  `\\b(?:${FAMILY})[\\d.]*:[a-z0-9]`,
  `\\b(?:${FAMILY}|${WORD})\\d`,
  `\\b(?:${WORD})[ -]\\d`,
  `\\b(?:${FAMILY}|${WORD}) (?:[vkr]?\\d|(?:opus|sonnet|haiku|fable)\\b)`,
  '\\bo[1-9]\\b',
  'opencode-go\\/',
].join('|'), 'i');
