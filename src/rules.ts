/**
 * Explicit field rules (data only). Ported in meaning from olliepm policy.py `_rules`.
 *
 * A rule tells blindfill WHERE the fields are on one page (form/container, frame, per-field CSS selector,
 * submit control). It never grants authorization: the item's vault URIs still decide which origins may
 * receive a secret, and every rule origin must be bound by the item. Rules hold CSS selectors only;
 * they are evaluated with the page's own querySelectorAll (no Playwright selector engines, no scripts).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath } from './config.js';
import { BlindfillError } from './core/types.js';

const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface RuleSubmit {
  selector: string;
  kind: 'native' | 'click' | 'js';
}
export interface Rule {
  id: string;
  /** exact origin the rule applies to (must be bound by the item) */
  top_origin: string;
  frame?: { selector: string; origin: string };
  /** exactly one of form (native <form>) / container (formless group) */
  form?: string;
  container?: string;
  /** field name -> CSS selector, resolved inside the form/container */
  fields: Record<string, string>;
  submit?: RuleSubmit;
  mode?: 'login' | 'registration';
  /** registration only: selector of the confirmation password field */
  confirm_password?: string;
  /** registration only: the form has no confirmation field */
  password_confirmation?: 'absent';
  /** login only: password-only stage of a multi-step login */
  password_purpose?: 'current';
}

const bad = (why: string): never => {
  throw new BlindfillError('POLICY', `invalid rules: ${why}`);
};

function keys(v: unknown, allowed: string[], required: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('expected an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`unknown key "${k}"`);
  for (const k of required) if (!(k in o)) bad(`missing key "${k}"`);
  return o;
}

function selector(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > 1000 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(v) ||
    /(^|[\s,>+~])(xpath|text|css|role|id|data-testid|internal:[a-z-]+)=/i.test(v) ||
    v.includes('>>')
  )
    return bad('selector must be plain CSS (no Playwright selector engines)');
  // value attributes and state pseudo-classes (:placeholder-shown, :invalid, ...) would turn a
  // match/no-match error into an oracle on what was typed
  const pseudos = v.replace(/\[[^\]]*\]/g, '').match(/::?[a-z-]+/gi) ?? [];
  if (
    /\[[^\]]*value/i.test(v) ||
    pseudos.some(
      (p) => !/^:(nth-of-type|nth-child|first-of-type|last-of-type|first-child|last-child|not)$/i.test(p),
    )
  )
    return bad('selector may not test values or input state');
  return v;
}

function origin(v: unknown): string {
  if (typeof v !== 'string') return bad('origin must be a string');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad('origin is not a URL');
  }
  if (
    !/^https?:$/.test(u.protocol) ||
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    !['', '/'].includes(u.pathname)
  )
    return bad('origin must be a bare http(s) origin');
  return u.origin;
}

export function validateRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw) || raw.length > 100) return bad('rules must be an array (max 100)');
  const seen = new Set<string>();
  return raw.map((r): Rule => {
    const o = keys(
      r,
      [
        'id',
        'top_origin',
        'frame',
        'form',
        'container',
        'fields',
        'submit',
        'mode',
        'confirm_password',
        'password_confirmation',
        'password_purpose',
      ],
      ['id', 'top_origin', 'fields'],
    );
    const id = o.id;
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id))
      bad('rule id must be unique [A-Za-z][A-Za-z0-9_-]*');
    seen.add(id as string);
    const mode = (o.mode ?? 'login') as string;
    if (mode !== 'login' && mode !== 'registration') bad('mode must be login or registration');
    const rule: Rule = {
      id: id as string,
      top_origin: origin(o.top_origin),
      fields: {},
      mode: mode as Rule['mode'],
    };
    if ((o.form === undefined) === (o.container === undefined)) bad('exactly one of form/container');
    if (o.form !== undefined) rule.form = selector(o.form);
    else rule.container = selector(o.container);
    const f = o.fields;
    if (
      !f ||
      typeof f !== 'object' ||
      Array.isArray(f) ||
      !Object.keys(f).length ||
      Object.keys(f).length > 50
    )
      bad('fields must be a non-empty object');
    for (const [name, sel] of Object.entries(f as Record<string, unknown>)) {
      if (!FIELD.test(name)) bad(`bad field name "${name}"`);
      rule.fields[name] = selector(sel);
    }
    if (o.frame !== undefined) {
      const fr = keys(o.frame, ['selector', 'origin'], ['selector', 'origin']);
      rule.frame = { selector: selector(fr.selector), origin: origin(fr.origin) };
    }
    if (o.submit !== undefined) {
      const s = keys(o.submit, ['selector', 'kind'], ['selector', 'kind']);
      if (
        !['native', 'click', 'js'].includes(s.kind as string) ||
        (rule.form === undefined && s.kind !== 'click')
      )
        bad('submit.kind must be native|click|js (container rules: click only)');
      rule.submit = { selector: selector(s.selector), kind: s.kind as RuleSubmit['kind'] };
    }
    if (o.password_purpose !== undefined) {
      if (
        o.password_purpose !== 'current' ||
        mode !== 'login' ||
        Object.keys(rule.fields).join() !== 'password'
      )
        bad('password_purpose=current needs a login rule with only a password field');
      rule.password_purpose = 'current';
    }
    if (mode === 'registration') {
      if (!('password' in rule.fields) || 'confirm_password' in rule.fields)
        bad('registration needs a password field and no confirm_password in fields');
      if (o.password_confirmation === 'absent') {
        if (o.confirm_password !== undefined)
          bad('confirm_password conflicts with password_confirmation=absent');
        rule.password_confirmation = 'absent';
      } else if (o.password_confirmation === undefined && o.confirm_password !== undefined)
        rule.confirm_password = selector(o.confirm_password);
      else bad('registration needs confirm_password or password_confirmation="absent"');
    } else if (o.confirm_password !== undefined || o.password_confirmation !== undefined)
      bad('confirm_password is for registration rules only');
    return rule;
  });
}

/** Item `blindfill.rules` content: v2 `{version:2, rules:[...]}`, a bare array, or legacy v1 `{v:1, fields}`. */
export interface ParsedRules {
  rules: Rule[];
  /** legacy v1 per-field selectors (kept working) */
  legacyFields?: Record<string, { selector?: string }>;
}

export function parseRulesValue(value: unknown): ParsedRules {
  if (value === undefined || value === null) return { rules: [] };
  if (Array.isArray(value)) return { rules: validateRules(value) };
  const o = value as {
    version?: number;
    v?: number;
    rules?: unknown;
    fields?: Record<string, { selector?: string }>;
  };
  if (o.version === 2 || o.version === 1) {
    if (!('rules' in o)) bad('missing rules');
    return { rules: validateRules(o.rules) };
  }
  if (o.fields) return { rules: [], legacyFields: o.fields };
  return { rules: [] };
}

// ---- local rules / profiles files: private files in the blindfill config directory ----------------------

export function configDir(): string {
  return process.env.BLINDFILL_CONFIG_DIR ?? dirname(configPath());
}

const LIMIT = 65536;

/** Private regular file, read once through an fd without following symlinks. Returns raw text. */
export function readPrivateFile(dir: string, name: string, errCode: 'POLICY' = 'POLICY'): string {
  const fail = (m: string): never => {
    throw new BlindfillError(errCode, m);
  };
  const uid = process.getuid?.();
  const d = lstatSync(dir, { throwIfNoEntry: false });
  if (!d) return fail('file not found');
  if (!d.isDirectory() || d.isSymbolicLink()) fail('config directory must be a real directory');
  if (uid !== undefined && (d.uid !== uid || d.mode & 0o022))
    fail('config directory must be owned by you and not group/world writable');
  const path = join(dir, name);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail('file not found');
    return fail('cannot open file (symlinks are refused)');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid) || st.mode & 0o077)
      fail('file must be a private regular file (mode 0600, one link, owned by you)');
    if (st.size > LIMIT) fail('file too large');
    const buf = Buffer.alloc(LIMIT + 1);
    const n = readSync(fd, buf, 0, LIMIT + 1, 0);
    const after = fstatSync(fd);
    if (n !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs)
      fail('file changed while reading');
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** JSON.parse that rejects duplicate keys and NaN/Infinity (ambiguity is refused, not guessed). */
export function strictJson(text: string): unknown {
  const dup = (src: string): void => {
    // cheap duplicate-key detector over the parsed token stream
    const stack: Set<string>[] = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
        const tok = src.slice(i, j + 1);
        let k = j + 1;
        while (/\s/.test(src[k] ?? '')) k++;
        if (src[k] === ':' && stack.length) {
          const s = stack[stack.length - 1];
          const key = JSON.parse(tok) as string;
          if (s.has(key)) bad('duplicate key');
          s.add(key);
        }
        i = j + 1;
        continue;
      }
      if (c === '{') stack.push(new Set());
      else if (c === '[') stack.push(new Set());
      else if (c === '}' || c === ']') stack.pop();
      i++;
    }
  };
  try {
    dup(text);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof BlindfillError) throw e;
    return bad('not valid JSON');
  }
}

/** Local rules file `<configDir>/rules/<itemId>.json` = {"version":1,"rules":[...]}. Optional. */
export function loadLocalRules(itemId: string, dir = join(configDir(), 'rules')): Rule[] {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(itemId)) return [];
  let text: string;
  try {
    text = readPrivateFile(dir, `${itemId}.json`);
  } catch (e) {
    if (e instanceof BlindfillError && e.message === 'file not found') return [];
    throw e;
  }
  const doc = keys(strictJson(text), ['version', 'rules'], ['version', 'rules']);
  if (doc.version !== 1) bad('version must be 1');
  return validateRules(doc.rules);
}
