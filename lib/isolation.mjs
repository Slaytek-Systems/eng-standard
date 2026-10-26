// Devbox project isolation (v0.11.0): every project on the devbox runs as one Unix user, so shared defaults (Convex's
// anonymous-agent state in ~/.convex, port 3210) let one project's tool reach another project's service. This module is
// pure: the .eng/project.toml identity file, argv secret detection, ownership-record checks and the repo check rules.
// IO lives in lib/isolation-cli.mjs.
import YAML from 'yaml';

export const IDENTITY_FILE = '.eng/project.toml';
export const DEFAULT_NAMES = ['default', 'anonymous-agent'];
export const DEFAULT_PORTS = [3210, 3211, 6791];
export const MODES = ['warn', 'fail'];
export const AGENT_ENV = ['ENG_AGENT_ID', 'T3_THREAD_ID'];
export const RESERVED_ENV = ['HOME', 'PATH', 'ENG_STATE', 'ENG_PORT', 'ENG_PROJECT', 'ENG_SERVICE', 'ENG_SERVICE_URL', 'ENG_SERVICE_PORT', 'ENG_RUN_TOKEN'];
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_WORD = '(?:secret|password|passwd|passphrase|token|(?:api|admin|access|private|secret|signing|encryption|master|session)-?key)';
const SECRET_ENV = /SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|(API|ADMIN|ACCESS|PRIVATE|SIGNING|ENCRYPTION|MASTER|SESSION)_?KEY/;

// ---------- TOML subset: comments, [table], [[array]], key = string | integer | boolean | one-line array | one-line inline table ----------
export function parseToml(text) {
  const root = {}; let cur = root;
  text.split('\n').forEach((raw, i) => {
    const line = stripComment(raw).trim(), at = `line ${i + 1}`;
    if (!line) return;
    let m;
    if ((m = line.match(/^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]$/))) { (root[m[1]] ??= []); if (!Array.isArray(root[m[1]])) throw new Error(`${at}: ${m[1]} is not an array of tables`); root[m[1]].push(cur = {}); return; }
    if ((m = line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]$/))) { if (root[m[1]] !== undefined) throw new Error(`${at}: table [${m[1]}] defined twice`); cur = root[m[1]] = {}; return; }
    if (!(m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/))) throw new Error(`${at}: expected key = value (supported: [table], [[array]], strings, integers, booleans, one-line arrays and inline tables)`);
    if (m[1] in cur) throw new Error(`${at}: key ${m[1]} defined twice`);
    const [v, rest] = value(m[2], at);
    if (rest.trim()) throw new Error(`${at}: unexpected text after the value`);
    cur[m[1]] = v;
  });
  return root;
}
function stripComment(s) { let q = null; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') return s.slice(0, i); } return s; }
function value(s, at) {
  s = s.trimStart();
  if (s[0] === '"') { let out = '', i = 1; for (; i < s.length && s[i] !== '"'; i++) { if (s[i] === '\\') { const e = s[++i]; out += { n: '\n', t: '\t', '"': '"', '\\': '\\' }[e] ?? (() => { throw new Error(`${at}: unsupported escape \\${e}`); })(); } else out += s[i]; } if (i >= s.length) throw new Error(`${at}: unterminated string`); return [out, s.slice(i + 1)]; }
  if (s[0] === "'") { const j = s.indexOf("'", 1); if (j < 0) throw new Error(`${at}: unterminated string`); return [s.slice(1, j), s.slice(j + 1)]; }
  if (s[0] === '[' || s[0] === '{') {
    const arr = s[0] === '[', close = arr ? ']' : '}', out = arr ? [] : {}; let rest = s.slice(1).trimStart();
    while (rest[0] !== close) {
      if (!rest) throw new Error(`${at}: unterminated ${arr ? 'array' : 'inline table'} (it must fit on one line)`);
      if (arr) { const [v, r] = value(rest, at); out.push(v); rest = r.trimStart(); }
      else { const k = rest.match(/^([A-Za-z0-9_-]+)\s*=\s*/); if (!k) throw new Error(`${at}: expected key = value in inline table`); const [v, r] = value(rest.slice(k[0].length), at); out[k[1]] = v; rest = r.trimStart(); }
      if (rest[0] === ',') rest = rest.slice(1).trimStart(); else if (rest[0] !== close) throw new Error(`${at}: expected , or ${close}`);
    }
    return [out, rest.slice(1)];
  }
  let m;
  if ((m = s.match(/^(true|false)\b/))) return [m[1] === 'true', s.slice(m[0].length)];
  if ((m = s.match(/^[+-]?\d+\b/))) return [Number(m[0]), s.slice(m[0].length)];
  throw new Error(`${at}: unsupported value ${s.split(/\s/)[0]}`);
}

// ---------- identity file ----------
// Returns { identity, errors }. identity is null when the file does not parse; errors lists every schema problem.
export function parseIdentity(text) {
  let raw; try { raw = parseToml(text); } catch (e) { return { identity: null, errors: [`${IDENTITY_FILE}: ${e.message}`] }; }
  const errs = [], p = raw.project ?? {}, isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  if (raw.schema !== 1) errs.push('schema must be 1');
  if (!isObj(raw.project)) errs.push('[project] table is required');
  if (!(typeof p.id === 'string' && NAME.test(p.id))) errs.push('project.id must be lower-case letters, digits and dashes (unique on the devbox)');
  else if (DEFAULT_NAMES.includes(p.id)) errs.push(`project.id "${p.id}" is a shared default name; pick one unique to this project`);
  if (!(typeof p.owner === 'string' && p.owner.trim())) errs.push('project.owner is required (the owner in the workspace registry)');
  else if (DEFAULT_NAMES.includes(p.owner)) errs.push(`project.owner "${p.owner}" is a shared default name`);
  const state = p.state;
  if (typeof state !== 'string' || !state || /^[~/$]/.test(state) || state.split('/').includes('..')) errs.push(`project.state "${state}" must be a path inside the checkout (no leading /, ~ or $HOME, no ..), e.g. ".eng/state"; shared home paths let projects share state`);
  const ports = p.ports;
  if (!(Array.isArray(ports) && ports.length === 2 && ports.every(n => Number.isInteger(n) && n >= 1024 && n <= 65535) && ports[0] <= ports[1])) errs.push('project.ports must be [low, high], integers from 1024 to 65535, low <= high');
  else { const hit = DEFAULT_PORTS.filter(d => d >= ports[0] && d <= ports[1]); if (hit.length) errs.push(`project.ports [${ports}] includes the shared default port(s) ${hit.join(', ')}; pick a range clear of ${DEFAULT_PORTS.join('/')}`); }
  const services = raw.services ?? [];
  if (!Array.isArray(services)) errs.push('services must be [[services]] tables');
  else if (!services.length) errs.push('at least one [[services]] table with an explicit name is required');
  const seen = new Set();
  for (const [i, s] of (Array.isArray(services) ? services : []).entries()) {
    const at = `services[${i}]${typeof s.name === 'string' ? ` (${s.name})` : ''}`;
    if (!(typeof s.name === 'string' && NAME.test(s.name))) errs.push(`${at}: name is required: lower-case letters, digits and dashes`);
    else if (DEFAULT_NAMES.includes(s.name)) errs.push(`${at}: "${s.name}" is a shared default name; name the service explicitly`);
    else if (seen.has(s.name)) errs.push(`${at}: duplicate service name`); else seen.add(s.name);
    if (!(Array.isArray(s.command) && s.command.length && s.command.every(x => typeof x === 'string' && x))) errs.push(`${at}: command must be a non-empty array of strings (argv, no shell)`);
    else {
      for (const f of argvSecrets(s.command)) errs.push(`${at}: command carries ${f} on argv; put the secret in .eng/secrets/${s.name}.env (0600) instead`);
      errs.push(...defaultsIn(s.command.join(' '), `${at}: command`));
    }
    if (s.port_env !== undefined && !(typeof s.port_env === 'string' && ENV_NAME.test(s.port_env))) errs.push(`${at}: port_env must be an env var name`);
    else if (RESERVED_ENV.includes(s.port_env)) errs.push(`${at}: port_env ${s.port_env} is set by eng and may not carry the port`);
    if (s.health !== undefined && !(typeof s.health === 'string' && s.health.startsWith('/'))) errs.push(`${at}: health must be an HTTP path starting with /`);
    if (s.ready_timeout_s !== undefined && !(Number.isInteger(s.ready_timeout_s) && s.ready_timeout_s > 0)) errs.push(`${at}: ready_timeout_s must be a positive integer`);
    for (const k of ['env', 'connect_env']) {
      if (s[k] === undefined) continue;
      if (!isObj(s[k]) || !Object.entries(s[k]).every(([n, v]) => ENV_NAME.test(n) && typeof v === 'string')) { errs.push(`${at}: ${k} must be an inline table of ENV_NAME = "string"`); continue; }
      for (const n of Object.keys(s[k]).filter(n => RESERVED_ENV.includes(n) || n === s.port_env)) errs.push(`${at}: ${k}.${n} is set by eng and may not be overridden`);
      for (const [n, v] of Object.entries(s[k])) errs.push(...defaultsIn(`${n}=${v}`, `${at}: ${k}.${n}`));
      for (const n of Object.keys(s[k]).filter(n => SECRET_ENV.test(n))) errs.push(`${at}: ${k}.${n} looks like a secret and this file is committed; put it in .eng/secrets/${s.name}${k === 'env' ? '' : '.connect'}.env (0600)`);
    }
  }
  if (errs.length) return { identity: null, errors: errs.map(e => `${IDENTITY_FILE}: ${e}`) };
  return { identity: { id: p.id, owner: p.owner, state, ports, services: services.map(s => ({ env: {}, connect_env: {}, ready_timeout_s: 30, ...s })) }, errors: [] };
}

// ---------- secrets on argv ----------
const FLAG = new RegExp(`^--?((?!no-)(?:[a-z0-9]+-)*${SECRET_WORD})(?:=(.*))?$`, 'i');
// Secret-looking flags that carry a value in an argv array: "--token x" (any next token, even one starting with -) or
// "--token=x". A "-file"/"-path" flag passes.
export function argvSecrets(argv) {
  const out = [];
  argv.forEach((a, i) => {
    const m = String(a).match(FLAG);
    if (m && (m[2] !== undefined ? m[2] !== '' : i + 1 < argv.length)) out.push(`--${m[1].replace(/^-+/, '')}`);
    else if (/^[A-Za-z_][A-Za-z0-9_]*=./.test(a) && SECRET_ENV.test(a.split('=')[0].toUpperCase())) out.push(`${a.split('=')[0]}=`);
    else if (/\s/.test(a)) { const e = lineSecret(String(a)); if (e) out.push(`${e} (inside argument ${i + 1})`); }
  });
  return out;
}
const LINE_FLAG = new RegExp(`(?:^|[\\s"'\`(])--?((?!no-)(?:[a-z0-9]+-)*${SECRET_WORD})(?:=|\\s+)[^\\s&|;]`, 'i');
// "env NAME=value cmd" puts the assignment on env's argv; a bare "NAME=value cmd" prefix is shell env and passes.
const ENV_ASSIGN = /(?:^|[\s;&|(`])env\s+((?:-\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[A-Za-z_][A-Za-z0-9_]*=\S)/;
// The flag or NAME= a command line would put on argv with a secret value, or null.
export function lineSecret(text) {
  const f = text.match(LINE_FLAG); if (f) return `--${f[1]}`;
  const e = text.match(ENV_ASSIGN);
  const name = e?.[1].match(/[A-Za-z_][A-Za-z0-9_]*(?==)/g)?.find(n => SECRET_ENV.test(n.toUpperCase()));
  return name ? `${name}=` : null;
}

// Streaming redaction of every non-empty secret value from a child's output. Every occurrence of every value is
// found in the original text and the union of their spans is replaced, so overlapping values never leave a
// fragment. A value split across chunks is held back until it is complete.
export function redactor(values) {
  const vals = [...new Set(values.filter(v => v.length > 0))], max = Math.max(0, ...vals.map(v => v.length));
  const spans = t => vals.flatMap(v => { const o = []; for (let i = t.indexOf(v); i >= 0; i = t.indexOf(v, i + 1)) o.push([i, i + v.length]); return o; });
  const redact = t => {
    const cover = new Uint8Array(t.length); for (const [a, b] of spans(t)) cover.fill(1, a, b);
    let out = ''; for (let i = 0; i < t.length; i++) if (!cover[i]) out += t[i]; else if (!cover[i - 1] || i === 0) out += '[redacted]';
    return out;
  };
  let carry = '';
  return {
    push(chunk) {
      const t = carry + chunk; if (!max) return t;
      let cut = Math.max(0, t.length - (max - 1)), moved = true;
      while (moved) { moved = false; for (const [a, b] of spans(t)) if (a < cut && b > cut) { cut = a; moved = true; } }
      carry = t.slice(cut); return redact(t.slice(0, cut));
    },
    end() { const t = carry; carry = ''; return redact(t); },
  };
}

// ---------- ownership records ----------
// /proc/<pid>/stat: comm (field 2) may hold spaces and parens, so split after the last ')'. Field 3 is index 0 there.
export function parseStat(text) {
  const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: f[0], pgid: Number(f[2]), startTime: f[19] };
}
// Every reason this record is not safe to act on. proc: { alive, startTime, bootId } read from /proc now.
export function recordProblems(rec, { identity, service, checkout, proc }) {
  const p = [];
  if (rec.service !== service) p.push(`record is for service ${rec.service}, not ${service}`);
  if (rec.project !== identity.id) p.push(`record is for project ${rec.project}, this checkout is ${identity.id}`);
  if (rec.owner !== identity.owner) p.push(`record owner ${rec.owner} does not match ${identity.owner}`);
  if (rec.checkout !== checkout) p.push(`record is for checkout ${rec.checkout}, not ${checkout}`);
  if (proc.bootId !== undefined && rec.boot_id !== proc.bootId) p.push(`stale record from an earlier boot (boot id ${rec.boot_id} is not this boot's); it names no live process`);
  else if (!proc.alive) p.push(`pid ${rec.pid} is not running`);
  else if (proc.startTime !== rec.start_time) p.push(`pid ${rec.pid} start time ${proc.startTime} does not match the recorded ${rec.start_time} (the pid was reused)`);
  return p;
}
export const agentId = (env = process.env) => AGENT_ENV.map(k => env[k]).find(v => v && v.trim())?.trim() ?? null;
// A program name safe to print: argv text can hold a NAME=value assignment, so anything with = or whitespace is withheld.
export const programName = a => /[=\s]/.test(String(a)) ? '<command>' : String(a);
export const scrubEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CONVEX_/.test(k)));
export const fill = (s, vars) => s.replace(/\{(port|state)\}/g, (_, k) => String(vars[k]));
// KEY=VALUE lines (blank lines and # comments allowed). Values are returned, never printed.
export function parseEnvFile(text, where) {
  const out = {};
  text.split('\n').forEach((l, i) => {
    const t = l.trim(); if (!t || t.startsWith('#')) return;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) throw new Error(`${where} line ${i + 1}: expected KEY=VALUE`);
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  });
  return out;
}

// ---------- repo checks (warn by default; isolation.mode: fail makes eng isolation check exit 1) ----------
export const validateIsolation = iso => iso === undefined ? [] : iso && typeof iso === 'object' && MODES.includes(iso.mode ?? 'warn') ? [] : [`isolation.mode must be ${MODES.join(' or ')}`];

const KIND = [
  ['package', /(^|\/)package\.json$/],
  ['hook', /^\.githooks\/|^\.husky\/(?!_\/)|(^|\/)lefthook(-local)?\.ya?ml$|^\.pre-commit-config\.ya?ml$/],
  ['compose', /(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/],
  ['script', /\.(sh|bash)$|(^|\/)(Makefile|[Jj]ustfile|Procfile)$/],
  ['env-example', /(^|\/)\.env(\.[\w-]+)?\.example$/],
];
export const fileKind = f => f.split('/').includes('node_modules') ? null : KIND.find(([, re]) => re.test(f))?.[0] ?? null;

export const RULES = {
  'identity-missing': `no ${IDENTITY_FILE}: declare the project id, owner, services, port range and state path (templates/isolation/project.toml)`,
  'identity-invalid': 'the identity file does not meet the schema',
  'default-name': 'shared default name (anonymous-agent): use the project id so tools cannot pick up another project\'s state',
  'default-port': `shared default port (${DEFAULT_PORTS.join('/')}) with no override: take ports from project.ports via eng run-service, or \${VAR:-port}`,
  'compose-unnamed': 'compose file has no top-level name: so its project name, containers and volumes are shared defaults',
  'compose-name': 'compose name: does not start with the project id, so it may collide with another project',
  'bare-service-command': 'reaches a service directly: wrap convex in eng connect <service> -- ... (or eng run-service) so the target is checked first; compose commands must name this project with -p <project id>...',
  'bare-kill': 'signals processes it may not own: use eng stop <service>, which stops only what this agent started',
  'secret-argv': 'secret-looking flag with a value on a command line (visible in /proc/<pid>/cmdline): pass it by env file (0600) or stdin',
};
const CONVEX = /(^|[\s;&|(`])((npx|bunx|pnpx|pnpm\s+(exec|dlx)|yarn|bun\s+x)\s+)?convex(@[\w.^~-]+)?\s+[a-z][\w-]*/;
// docker/podman [global options] compose ..., or the docker-compose / podman-compose binaries. A global option
// (--context x, -H host, --log-level=x) may sit between the binary and compose.
export function isCompose(text) {
  if (/(^|[\s/"'`(])(docker|podman)-compose\b/.test(text)) return true;
  const t = text.split(/\s+/).map(x => x.replace(/^["'`(]+|["'`);]+$/g, ''));
  for (let i = 0; i < t.length; i++) {
    if (!/^(.*\/)?(docker|podman)$/.test(t[i])) continue;
    let j = i + 1;
    while (t[j]?.startsWith('-')) j += !t[j].includes('=') && t[j + 1] && !t[j + 1].startsWith('-') && t[j + 1] !== 'compose' ? 2 : 1;
    if (t[j] === 'compose') return true;
  }
  return false;
}
// A compose command acts on whatever project it names, so it is in bounds only when -p/--project-name (or
// COMPOSE_PROJECT_NAME) names this project; going through eng connect does not change what it reaches.
export function composeOutOfBounds(text, id) {
  if (!isCompose(text)) return false;
  const name = text.match(/(?:^|\s)(?:-p|--project-name)(?:\s+|=)["']?([^\s"';&|]+)/)?.[1] ?? text.match(/\bCOMPOSE_PROJECT_NAME=["']?([^\s"';&|]+)/)?.[1];
  return !(id && name && namesProject(name, id));
}
// The project id itself, or <id>_<suffix>. Ids never contain _, so the match is unambiguous: with - as the separator,
// alpha-beta would name both project alpha and project alpha-beta.
export const namesProject = (name, id) => name === id || name.startsWith(`${id}_`);
const KILL = /(^|[\s;&|(`])(kill|pkill|killall)(\s|$)|\b(docker|podman)\s+(stop|kill|rm)\b/;
// anonymous-agent anywhere; "default" only where it names a project, deployment, container or compose project.
const DEFAULT_NAME = /\banonymous-agent\b|(\b(name|container_name|project|deployment)\s*[:=]\s*|\b[A-Z_]*(PROJECT_NAME|DEPLOYMENT|_NAME)=|(^|\s)(-p|--[\w-]*(?:name|project|deployment))(\s+|=))["']?default\b/;
const WRAPPED = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpm\s+exec|yarn)\s+)?eng\s+(connect|run-service)\b/;
const PORT = new RegExp(`(?<![\\w.])(${DEFAULT_PORTS.join('|')})(?![\\w.])`);
const OVERRIDE = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-[^}]*\}/g;

// Default names and ports inside the identity file's own commands and env values.
function defaultsIn(text, at) {
  const errs = [];
  if (DEFAULT_NAME.test(text)) errs.push(`${at} uses a shared default name (anonymous-agent or default); use the project id`);
  const port = text.replace(OVERRIDE, '').match(PORT);
  if (port) errs.push(`${at} uses the shared default port ${port[1]}; use {port} from project.ports`);
  return errs;
}

// files: [{ path, text }] (tracked, not generated by eng sync). identityText: the identity file or null.
// Returns [{ file, line, rule, text, message }] in the same shape as eng lint hits.
export function isolationFindings(files, identityText) {
  const out = [], add = (file, line, rule, text, extra = '') => out.push({ file, line, rule, text, message: RULES[rule] + extra });
  let id = null;
  if (identityText === null) add(IDENTITY_FILE, 1, 'identity-missing', '');
  else { const r = parseIdentity(identityText); id = r.identity?.id ?? null; for (const e of r.errors) add(IDENTITY_FILE, 1, 'identity-invalid', '', `: ${e.replace(`${IDENTITY_FILE}: `, '')}`); }
  for (const { path: file, text } of files) {
    const kind = fileKind(file); if (!kind) continue;
    const lines = text.split('\n'), units = [];
    if (kind === 'package') {
      let scripts = {}; try { scripts = JSON.parse(text).scripts ?? {}; } catch { continue; }
      for (const [name, cmd] of Object.entries(scripts)) if (typeof cmd === 'string') units.push({ line: Math.max(1, lines.findIndex(l => l.includes(JSON.stringify(name) + ':') || l.includes(JSON.stringify(name) + ' :')) + 1), text: cmd, where: ` (script "${name}")` });
    } else lines.forEach((l, i) => { if (!/^\s*(#|\/\/)/.test(l)) units.push({ line: i + 1, text: l, where: '' }); });
    for (const u of units) {
      if (DEFAULT_NAME.test(u.text)) add(file, u.line, 'default-name', u.text, u.where);
      if (kind === 'env-example') continue;
      if (PORT.test(u.text.replace(OVERRIDE, ''))) add(file, u.line, 'default-port', u.text, u.where);
      if (lineSecret(u.text)) add(file, u.line, 'secret-argv', u.text, u.where);
      if (kind !== 'package' && kind !== 'hook') continue;
      if (u.text.split(/&&|\|\||[;|&]/).some(seg => (CONVEX.test(seg) && !WRAPPED.test(seg)) || composeOutOfBounds(seg, id))) add(file, u.line, 'bare-service-command', u.text, u.where);
      if (KILL.test(u.text)) add(file, u.line, 'bare-kill', u.text, u.where);
    }
    if (kind === 'compose') {
      let doc; try { doc = YAML.parse(text); } catch { continue; }
      const name = doc && typeof doc === 'object' ? doc.name : undefined;
      for (const [svcName, def] of Object.entries(doc?.services ?? {})) for (const k of ['command', 'entrypoint']) {
        const v = def?.[k];
        const leaks = Array.isArray(v) ? argvSecrets(v.map(String)).length : typeof v === 'string' && !!lineSecret(v.replace(/\s+/g, ' '));
        if (leaks && !out.some(h => h.file === file && h.rule === 'secret-argv'))
          add(file, Math.max(1, lines.findIndex(l => new RegExp(`^\\s*${k}\\s*:`).test(l)) + 1), 'secret-argv', '', ` (service "${svcName}" ${k})`);
      }
      if (typeof name !== 'string' || !name.trim() || DEFAULT_NAMES.includes(name)) add(file, 1, 'compose-unnamed', '');
      else if (id && !namesProject(name, id)) add(file, Math.max(1, lines.findIndex(l => /^name\s*:/.test(l)) + 1), 'compose-name', `name: ${name}`, ` (want "${id}" or "${id}_...")`);
    }
  }
  return out;
}
