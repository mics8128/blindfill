import { createHash, createPrivateKey, sign } from 'node:crypto';
import { AndroidActuator } from './actuators/android/index.js';
import { bwCredentialId, credentialIdBase64, type BwFido2Credential } from './backends/bwmap.js';
import type { Backend, ItemPatch } from './backends/spi.js';
import { audit } from './core/audit.js';
import { androidPackages, checkAndroidBinding, checkWebBinding, SubmitGuard } from './core/policy.js';
import { globalScrubber } from './core/scrubber.js';
import { BlindfillError, formatTarget, type ItemMeta, type ItemRef, type Target } from './core/types.js';
import type {
  Detected,
  Expect,
  EvidenceResult,
  ProbeResult,
  CandidateInfo,
  WebActuator,
} from './actuators/web/web.js';
import type { Role } from './actuators/web/heuristics.js';
import { loadLocalRules, parseRulesValue, type ParsedRules, type Rule } from './rules.js';
import type { Profile } from './profiles.js';
import {
  generatePassword,
  passwordMatches,
  validatePasswordPolicy,
  type PasswordPolicy,
} from './password.js';

/**
 * A setup key (base32, spaces/dashes allowed, any case) or an otpauth://totp URI, as stored by the backend:
 * the bare seed, or the URI when it sets a non-default algorithm, digits or period. Errors never echo input.
 */
export function normalizeTotpSeed(raw: string): string {
  globalScrubber.register(raw.trim());
  const bad = () =>
    new BlindfillError(
      'POLICY',
      'the element holds no TOTP setup key (base32, 16-128 chars) or otpauth://totp URI',
    );
  const found = raw.match(/otpauth:\/\/\S+/i)?.[0];
  let uri: URL | undefined;
  if (found) {
    try {
      uri = new URL(found);
    } catch {
      throw bad();
    }
    if (uri.host.toLowerCase() !== 'totp') throw bad();
  }
  const seed = (uri ? (uri.searchParams.get('secret') ?? '') : raw)
    .replace(/[\s-]+/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!/^[A-Z2-7]{16,128}$/.test(seed)) throw bad();
  globalScrubber.register(seed);
  const p = uri?.searchParams;
  const custom =
    !!p &&
    ((p.get('algorithm') ?? 'SHA1').toUpperCase() !== 'SHA1' ||
      (p.get('digits') ?? '6') !== '6' ||
      (p.get('period') ?? '30') !== '30');
  if (!uri || !custom) return seed;
  uri.searchParams.set('secret', seed);
  globalScrubber.register(uri.toString());
  return uri.toString();
}

export interface ItemSelector {
  /** backend item id */
  item?: string;
  /** free-text search; must resolve to exactly one item */
  query?: string;
}

export interface FillRequest extends ItemSelector {
  /** field names: username, password, totp, or other item field names. Default: username,password */
  fields?: string[];
  /** navigate here first (the item binding is checked against the page the browser ends up on) */
  url?: string;
  submit?: boolean;
  expect?: Expect;
  /** explicit rule id from the item's rules (required for registration; chosen by origin for login) */
  rule?: string;
}

export interface FillResult {
  origin: string;
  item: { id: string; name: string };
  filled: string[];
  /** true when a secret was written: the session is now locked */
  locked: boolean;
  submitted: boolean;
  outcome: EvidenceResult['outcome'] | 'not_submitted';
  evidence?: { matched: EvidenceResult['matched']; url: string };
  notes: string[];
}

export type ReadableItem = {
  id: string;
  name: string;
  username?: string;
  uris: { uri: string; match: string }[];
  readable: Record<string, string>;
  /** names only: these can be filled but never read */
  secretFields: string[];
  hasTotp: boolean;
  control: { submit: string; signers: string[]; hasRules: boolean };
  notes?: string;
};

export function readableView(m: ItemMeta): ReadableItem {
  return {
    id: m.ref.id,
    name: m.name,
    username: m.username,
    uris: m.uris,
    readable: m.readable,
    secretFields: m.secretFields,
    hasTotp: m.hasTotp,
    control: {
      submit: m.control.submit,
      signers: m.control.signers,
      hasRules: m.control.rules !== undefined,
    },
    notes: m.notes,
  };
}

type Step = { name: string; kind: 'readable' | 'secret' | 'totp' };
interface Plan {
  act: WebActuator;
  target: { kind: 'web'; origin: string };
  tname: string;
  ref: ItemRef;
  meta: ItemMeta;
  isBound: (u: string) => boolean;
  steps: Step[];
  rule?: Rule;
  locator: (name: string, role?: Role) => (ds?: Detected[]) => Promise<Detected>;
}
export interface DiscoverResult {
  status: 'planned';
  origin: string;
  item: { id: string; name: string };
  rule_id: string | null;
  fields: string[];
  submit: 'not_attempted';
  submit_validated: boolean;
  secrets_read: false;
}
export interface RegisterResult {
  origin: string;
  item: { id: string; name: string };
  rule_id: string;
  filled: string[];
  locked: boolean;
  submitted: boolean;
  registration_outcome: EvidenceResult['outcome'] | 'not_submitted';
  evidence?: { matched: EvidenceResult['matched']; url: string };
  notes: string[];
}

interface RulesV1 {
  v?: number;
  fields?: Record<string, { selector?: string }>;
}

const fieldRole = (n: string): Role | null =>
  n === 'username' || n === 'password' || n === 'totp' ? n : null;

export const HANDOFF_REASONS = ['captcha', 'consent', 'mfa', 'other'] as const;

export class Engine {
  constructor(
    private backend: Backend,
    private web?: WebActuator,
    private persist: () => void = () => undefined,
  ) {}

  private actuator(): WebActuator {
    const w = this.rawActuator();
    w.policy.assertActive('this action');
    return w;
  }

  private rawActuator(): WebActuator {
    if (!this.web) throw new BlindfillError('ACTUATOR', 'no browser attached');
    return this.web;
  }

  async resolveItem(sel: ItemSelector, target?: Target): Promise<ItemRef> {
    if (sel.item) return { backend: this.backend.id, id: sel.item };
    const refs = sel.query
      ? await this.backend.find({ query: sel.query })
      : target
        ? await this.backend.find({ target })
        : [];
    if (refs.length === 0) throw new BlindfillError('NOT_FOUND', 'no matching item');
    if (refs.length > 1)
      throw new BlindfillError(
        'AMBIGUOUS',
        `${refs.length} items match; pass an explicit item id. Candidates: ${refs.map((r) => `${r.id} (${r.name ?? '?'})`).join(', ')}`,
      );
    return refs[0];
  }

  // ---- human handoff: a person takes the browser (CAPTCHA, consent, push-MFA); blindfill steps aside ----

  private handoffView(): Record<string, unknown> {
    const act = this.rawActuator();
    const pages = act.listPages();
    return {
      status: act.policy.paused ? 'paused' : 'active',
      reason: act.policy.paused?.reason ?? null,
      since: act.policy.paused?.since ?? null,
      locked: act.policy.locked,
      pages,
      secrets_exposed: false,
    };
  }

  /**
   * Pause: from now every agent-driven action (fill, probe, discover, diagnose, verify, register, totp fill)
   * is refused until resume. The agent learns only origin+path of open pages. The human works in the
   * visible browser; blindfill never transmits, records or inspects what they do.
   */
  handoffPause(reason: string): Record<string, unknown> {
    const act = this.rawActuator();
    if (!HANDOFF_REASONS.includes(reason as never))
      throw new BlindfillError('POLICY', `reason must be one of: ${HANDOFF_REASONS.join(', ')}`);
    if (act.policy.paused) throw new BlindfillError('POLICY', 'session is already paused');
    act.policy.paused = { reason, since: new Date().toISOString() };
    this.persist();
    audit({ event: 'session', backend: this.backend.id, outcome: `paused:${reason}` });
    return {
      ...this.handoffView(),
      note: 'a human now has the browser; agent actions are refused until handoff resume',
    };
  }

  /**
   * Resume. Nothing is trusted from the pause: the post-fill lock and one-shot counters are untouched, and
   * the next fill re-checks origin binding against wherever the page is now. The human is not authenticated
   * (an agent could call resume itself); the controls here limit what an agent can do, not who it is.
   */
  handoffResume(): Record<string, unknown> {
    const act = this.rawActuator();
    if (!act.policy.paused) throw new BlindfillError('POLICY', 'session is not paused');
    const reason = act.policy.paused.reason;
    act.policy.paused = null;
    this.persist();
    audit({ event: 'session', backend: this.backend.id, outcome: `resumed:${reason}` });
    return {
      ...this.handoffView(),
      note: 'resumed; lock and one-shot counters unchanged; bindings are re-checked on the next action',
    };
  }

  handoffStatus(): Record<string, unknown> {
    return this.handoffView();
  }

  // ---- item administration (no value of a secret-class field is ever read or printed) ----

  async itemList(query = ''): Promise<unknown> {
    const refs = await this.backend.find({ query });
    const items = [];
    for (const r of refs.slice(0, 100)) {
      const m = await this.backend.meta(r);
      items.push({
        id: r.id,
        name: m.name,
        origins: m.uris.map((u) => u.uri),
        fields: ['username', ...(m.hasTotp ? ['totp'] : []), ...m.secretFields, ...Object.keys(m.readable)],
        rules: m.control.rules === undefined ? 0 : 1,
      });
    }
    return { status: 'completed', items, truncated: refs.length > 100 };
  }

  /** Structural status: which fields exist and how they are classified; no values. */
  async itemStatus(sel: ItemSelector): Promise<unknown> {
    const ref = await this.resolveItem(sel);
    const m = await this.backend.meta(ref);
    const parsed = (() => {
      try {
        return this.rulesFor(ref, m).rules.map((r) => ({
          id: r.id,
          mode: r.mode ?? 'login',
          origin: r.top_origin,
        }));
      } catch {
        return 'invalid';
      }
    })();
    return {
      status: 'completed',
      id: ref.id,
      name: m.name,
      backend: this.backend.id,
      origins: m.uris,
      fields: [
        ...(m.username ? [{ name: 'username', class: 'readable' }] : []),
        ...Object.keys(m.readable).map((name) => ({ name, class: 'readable' })),
        ...m.secretFields.map((name) => ({ name, class: 'secret' })),
        ...(m.hasTotp ? [{ name: 'totp', class: 'totp' }] : []),
      ],
      rules: parsed,
      registration_allowed: m.control.registration,
      password_policy: m.control.passwordPolicy !== undefined,
      submit: m.control.submit,
      secrets_exposed: false,
    };
  }

  async itemRename(sel: ItemSelector, newName: string): Promise<unknown> {
    const ref = await this.resolveItem(sel);
    await this.assertNameFree(newName);
    await this.writable().updateItem(ref, { name: newName });
    audit({ event: 'item', backend: this.backend.id, item: ref.id, outcome: 'renamed' });
    return { status: 'completed', id: ref.id, name: newName };
  }

  /**
   * Edit one item. Replacing origins, setting any blindfill.* control field and writing a secret-class value
   * widen or change what can be filled, so the caller must assert a human is at a terminal (`human: true`;
   * the CLI passes isTTY). Plain readable fields do not need it. Secret values are written, never read.
   */
  async itemEdit(
    sel: ItemSelector,
    req: {
      origins?: string[];
      username?: string;
      set?: Record<string, string>;
      unset?: string[];
      secrets?: Record<string, string>;
      human: boolean;
    },
  ): Promise<unknown> {
    const b = this.writable();
    const ref = await this.resolveItem(sel);
    const meta = await this.backend.meta(ref);
    const patch: ItemPatch = {};
    const fields: Record<string, string | null> = {};
    const control = (n: string) => n.toLowerCase().startsWith('blindfill.');
    const changed: string[] = [];
    if (req.origins) {
      patch.uris = req.origins.map((o) => Engine.canonicalOrigin(o));
      changed.push('origins');
    }
    if (req.username !== undefined) {
      patch.username = req.username;
      changed.push('username');
    }
    for (const [n, v] of Object.entries(req.set ?? {})) {
      // built-in secret keys too: a readable field named card.number would pass a value via argv as text
      if (
        meta.secretFields.includes(n) ||
        /^(password|passkey|totp|card\.(number|code)|ssh\..*|fido2.*)$/i.test(n)
      )
        throw new BlindfillError(
          'SECRET_ACCESS',
          `"${n}" is a secret-class field: use the hidden secret prompt`,
        );
      if (control(n) && n.toLowerCase() === 'blindfill.password_policy')
        validatePasswordPolicy(JSON.parse(v));
      if (control(n) && n.toLowerCase() === 'blindfill.rules') parseRulesValue(JSON.parse(v));
      fields[n] = v;
      changed.push(n);
    }
    for (const n of req.unset ?? []) {
      if (meta.secretFields.includes(n))
        throw new BlindfillError('SECRET_ACCESS', `"${n}" is a secret-class field`);
      fields[n] = null;
      changed.push(n);
    }
    if (Object.keys(fields).length) patch.fields = fields;
    // blindfill.rules is agent-editable (owner decision 2026-11-27); other control fields are not
    const sensitive =
      !!req.origins ||
      Object.keys(fields).some((n) => control(n) && n.toLowerCase() !== 'blindfill.rules') ||
      Object.keys(req.secrets ?? {}).length > 0;
    if (sensitive && !req.human)
      throw new BlindfillError(
        'POLICY',
        'changing origins, blindfill.* control fields or secret values needs a human at a terminal',
      );
    for (const n of Object.keys(req.secrets ?? {}))
      // "totp" names the item's TOTP seed for the backend; seeds are added only by totp enroll
      if (n === 'totp' || !meta.secretFields.includes(n))
        throw new BlindfillError('NOT_FOUND', 'item has no secret field with that name');
    if (!changed.length && !Object.keys(req.secrets ?? {}).length)
      throw new BlindfillError('POLICY', 'nothing to change');
    if (Object.keys(patch).length) await b.updateItem(ref, patch);
    for (const [n, v] of Object.entries(req.secrets ?? {})) {
      globalScrubber.register(v);
      await b.updateSecret(ref, n, v);
      changed.push(`${n} (secret)`);
    }
    audit({
      event: 'item',
      backend: b.id,
      item: ref.id,
      fields: changed.map((c) => c.split(' ')[0]),
      outcome: 'edited',
    });
    return { status: 'completed', id: ref.id, changed, secret_exposed: false };
  }

  // ---- item creation (needs backend capability WRITE) ----

  private writable(): Backend & Required<Pick<Backend, 'createItem' | 'updateSecret' | 'updateItem'>> {
    const b = this.backend;
    if (!b.capabilities.has('WRITE') || !b.createItem || !b.updateSecret || !b.updateItem)
      throw new BlindfillError(
        'UNSUPPORTED',
        `backend "${b.id}" cannot write items; create the item in the vault app`,
      );
    return b as never;
  }

  /** Exact origin only: https (or http on loopback for local development); no path, query or credentials. */
  static canonicalOrigin(value: string): string {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      throw new BlindfillError('POLICY', 'invalid origin');
    }
    const loopback =
      u.hostname === 'localhost' ||
      u.hostname.endsWith('.localhost') ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '[::1]';
    if (
      !(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) ||
      (u.pathname !== '/' && u.pathname !== '') ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw new BlindfillError(
        'POLICY',
        'origin must be an exact https origin (scheme://host[:port]); http only for localhost',
      );
    return u.origin;
  }

  private async assertNameFree(name: string): Promise<void> {
    if (
      !name ||
      name.length > 100 ||
      [...name].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
    )
      throw new BlindfillError('POLICY', 'item name must be 1-100 printable characters');
    const same = (await this.backend.find({ query: name })).filter((r) => r.name === name);
    if (same.length) throw new BlindfillError('POLICY', 'an item with this name already exists');
  }

  /**
   * Generate a password under an optional data-only policy and save it as a new item. The value is written
   * straight to the backend and is never returned, printed or logged. Does not touch any website.
   * The item is created with blindfill.registration=allow unless `registration` is false (generating a
   * password is how a registration is prepared).
   */
  async itemGenerate(req: {
    name: string;
    origins: string[];
    username: string;
    displayName?: string;
    length?: number;
    policy?: unknown;
    registration?: boolean;
  }): Promise<Record<string, unknown>> {
    const b = this.writable();
    if (!req.username || (req.displayName !== undefined && !req.displayName))
      throw new BlindfillError('POLICY', 'username must be non-empty');
    if (!req.origins?.length) throw new BlindfillError('POLICY', 'at least one origin is required');
    const origins = req.origins.map((o) => Engine.canonicalOrigin(o));
    const policy = req.policy === undefined ? undefined : validatePasswordPolicy(req.policy);
    await this.assertNameFree(req.name);
    const password = generatePassword(policy, req.length);
    globalScrubber.register(password);
    const fields: Record<string, string> = {};
    if (req.displayName !== undefined) fields.display_name = req.displayName;
    if (req.registration !== false) fields['blindfill.registration'] = 'allow';
    if (policy) fields['blindfill.password_policy'] = JSON.stringify(policy);
    const ref = await b.createItem({
      name: req.name,
      username: req.username,
      uris: origins,
      password,
      fields,
    });
    audit({ event: 'item', backend: b.id, item: ref.id, outcome: 'generated' });
    return {
      status: 'completed',
      id: ref.id,
      name: req.name,
      origins,
      password_generated: true,
      secret_exposed: false,
      registration_enabled: req.registration !== false,
      registration_outcome: 'not_attempted',
    };
  }

  /** Create an item from values the caller already holds (the CLI reads the password from a TTY). */
  async itemCreate(req: {
    name?: string;
    origins: string[];
    username: string;
    password: string;
    totpSeed?: string;
    policy?: unknown;
  }): Promise<Record<string, unknown>> {
    const b = this.writable();
    if (!req.origins?.length) throw new BlindfillError('POLICY', 'at least one origin is required');
    const origins = req.origins.map((o) => Engine.canonicalOrigin(o));
    const name = req.name ?? `${new URL(origins[0]).host}/${req.username}`;
    await this.assertNameFree(name);
    globalScrubber.register(req.password);
    if (req.totpSeed) globalScrubber.register(req.totpSeed);
    const policy = req.policy === undefined ? undefined : validatePasswordPolicy(req.policy);
    const ref = await b.createItem({
      name,
      username: req.username,
      uris: origins,
      password: req.password,
      totpSeed: req.totpSeed,
      fields: policy ? { 'blindfill.password_policy': JSON.stringify(policy) } : undefined,
    });
    audit({ event: 'item', backend: b.id, item: ref.id, outcome: 'created' });
    return { status: 'completed', id: ref.id, name, origins, secret_exposed: false };
  }

  /** Read or replace only the non-secret password policy; never changes the password. Writes need a human. */
  async itemPasswordPolicy(
    sel: ItemSelector,
    policy?: unknown,
    human = false,
  ): Promise<Record<string, unknown>> {
    const ref = await this.resolveItem(sel);
    if (policy !== undefined) {
      // an agent-chosen policy checked against the stored password at register time would leak its shape
      if (!human) throw new BlindfillError('POLICY', 'changing a password policy needs a terminal (human)');
      const v = validatePasswordPolicy(policy);
      await this.writable().updateItem(ref, { fields: { 'blindfill.password_policy': JSON.stringify(v) } });
      audit({ event: 'item', backend: this.backend.id, item: ref.id, outcome: 'policy_updated' });
    }
    const meta = await this.backend.meta(ref);
    return {
      status: 'completed',
      id: ref.id,
      password_policy: meta.control.passwordPolicy ?? null,
      policy_updated: policy !== undefined,
      password_changed: false,
    };
  }

  async itemShow(sel: ItemSelector): Promise<ReadableItem> {
    const ref = await this.resolveItem(sel);
    return readableView(await this.backend.meta(ref));
  }

  async totpCode(sel: ItemSelector): Promise<{ code: string; item: string; note: string }> {
    const ref = await this.resolveItem(sel);
    const code = await this.backend.totpCode(ref);
    audit({ event: 'totp', backend: this.backend.id, item: ref.id, outcome: 'returned' });
    return { code, item: ref.id, note: 'valid for ~30 seconds' };
  }

  /**
   * Add a TOTP seed to an item that has none, read by blindfill from one element of the current page
   * (a setup key, or an otpauth:// URI in its href, value or text). The seed goes straight to the backend;
   * nothing about it is returned, printed or logged. Add-only: an existing seed is never replaced.
   */
  async totpEnroll(req: ItemSelector & { selector: string }): Promise<Record<string, unknown>> {
    const b = this.writable();
    if (!b.capabilities.has('TOTP'))
      throw new BlindfillError('UNSUPPORTED', `backend "${b.id}" does not store TOTP seeds`);
    const act = this.actuator();
    const { target, url } = act.identify();
    const tname = formatTarget(target);
    const ref = await this.resolveItem(req, target);
    const meta = await b.meta(ref);
    const refuse = (err: BlindfillError): never => {
      audit({
        event: 'refused',
        backend: b.id,
        item: ref.id,
        target: tname,
        reason: `${err.code}: totp enroll`,
      });
      throw err;
    };
    const bind = checkWebBinding(url, meta);
    if (!bind.ok)
      refuse(
        new BlindfillError('ORIGIN_MISMATCH', `refused: ${tname} is not bound by this item (${bind.reason})`),
      );
    if (meta.hasTotp)
      refuse(
        new BlindfillError('POLICY', 'this item already has a TOTP seed; enroll only adds, never replaces'),
      );
    let seed: string;
    try {
      seed = normalizeTotpSeed(await act.readSetupKey(req.selector));
      // the page may have navigated while we read: the element must still be on a bound page
      if (!checkWebBinding(act.identify().url, meta).ok)
        throw new BlindfillError(
          'ORIGIN_MISMATCH',
          'the page left the bound origin while reading; nothing saved',
        );
    } catch (e) {
      return refuse(e as BlindfillError);
    }
    globalScrubber.register(seed);
    await b.updateSecret(ref, 'totp', seed);
    audit({ event: 'item', backend: b.id, item: ref.id, target: tname, outcome: 'totp_enrolled' });
    return { status: 'completed', id: ref.id, totp_enrolled: true, secret_exposed: false };
  }

  async probe(url?: string): Promise<ProbeResult & { items?: { id: string; name?: string }[] }> {
    const act = this.actuator();
    if (url) {
      act.policy.assertReadable('page probe'); // locked sessions must not navigate either
      await act.navigate(url);
    }
    const p = await act.probe();
    let items: { id: string; name?: string }[] | undefined;
    try {
      items = (await this.backend.find({ target: { kind: 'web', origin: p.origin } })).map((r) => ({
        id: r.id,
        name: r.name,
      }));
    } catch {
      items = undefined; // locked vault etc.: probe still works
    }
    audit({ event: 'probe', backend: this.backend.id, target: `web:${p.origin}`, outcome: 'ok' });
    return { ...p, items };
  }

  async candidates(role?: Role, url?: string): Promise<{ origin: string; candidates: CandidateInfo[] }> {
    const act = this.actuator();
    if (url) {
      act.policy.assertReadable('page probe');
      await act.navigate(url);
    }
    const p = await act.probe();
    const c = role ? p.candidates.filter((x) => x.guess?.role === role) : p.candidates;
    return { origin: p.origin, candidates: c };
  }

  /** Rules for an item: its `blindfill.rules` field plus an optional private local file. */
  private rulesFor(ref: ItemRef, meta: ItemMeta): ParsedRules {
    const parsed = parseRulesValue(meta.control.rules);
    const local = loadLocalRules(ref.id);
    const ids = new Set(parsed.rules.map((r) => r.id));
    for (const r of local)
      if (ids.has(r.id))
        throw new BlindfillError('POLICY', `rule id "${r.id}" is defined twice (item and local file)`);
    return { ...parsed, rules: [...parsed.rules, ...local] };
  }

  /** Pick the rule for this page. Login rules are chosen by observed origin; registration needs an explicit id. */
  private selectRule(
    req: { rule?: string; ruleOverride?: Rule },
    parsed: ParsedRules,
    origin: string,
    meta: ItemMeta,
    mode: 'login' | 'registration',
    isBound: (u: string) => boolean,
  ): Rule | undefined {
    let rule: Rule | undefined = req.ruleOverride;
    if (!rule && req.rule) {
      rule = parsed.rules.find((r) => r.id === req.rule);
      // never echo caller input in errors: a scrubbed echo is a secret-guessing oracle
      if (!rule) throw new BlindfillError('POLICY', 'unknown rule id');
    }
    if (!rule) {
      if (mode === 'registration')
        throw new BlindfillError(
          'POLICY',
          'registration needs an explicit rule id (--rule); nothing is inferred',
        );
      const m = parsed.rules.filter((r) => (r.mode ?? 'login') === 'login' && r.top_origin === origin);
      if (m.length > 1) {
        const e = new BlindfillError(
          'AMBIGUOUS',
          `several login rules match this origin; select one explicitly (rule ids: ${m.map((r) => r.id).join(', ')})`,
        );
        (e as BlindfillError & { ruleIds?: string[] }).ruleIds = m.map((r) => r.id);
        throw e;
      }
      rule = m[0];
    }
    if (!rule) return undefined;
    if ((rule.mode ?? 'login') !== mode)
      throw new BlindfillError('POLICY', `rule "${rule.id}" is a ${rule.mode ?? 'login'} rule, not ${mode}`);
    if (rule.top_origin !== origin)
      throw new BlindfillError(
        'ORIGIN_MISMATCH',
        `rule "${rule.id}" is for ${rule.top_origin}, not this page`,
      );
    if (!isBound(rule.top_origin + '/') || (rule.frame && !isBound(rule.frame.origin + '/')))
      throw new BlindfillError(
        'ORIGIN_MISMATCH',
        `rule "${rule.id}" names an origin the vault item does not bind`,
      );
    return rule;
  }

  /** Steps 1-3 of every web operation: binding, rule, field classification, locate-all. No secret is read. */
  private async prepare(
    req: FillRequest & { ruleOverride?: Rule },
    mode: 'login' | 'registration',
    opts: { confirmField?: boolean } = {},
  ): Promise<Plan> {
    const act = this.actuator();
    if (req.url) await act.navigate(req.url);
    const { target, url } = act.identify();
    const tname = formatTarget(target);
    const ref = await this.resolveItem(req, target);
    const meta = await this.backend.meta(ref);
    const refuse = (reason: string, err: BlindfillError): never => {
      audit({ event: 'refused', backend: this.backend.id, item: ref.id, target: tname, reason });
      throw err;
    };

    // 1. origin binding, before any secret is read
    const bind = checkWebBinding(url, meta);
    if (!bind.ok)
      refuse(
        bind.reason,
        new BlindfillError('ORIGIN_MISMATCH', `refused: ${tname} is not bound by this item (${bind.reason})`),
      );
    const isBound = (u: string) => checkWebBinding(u, meta).ok;

    // 2. rule (explicit field map) and request classification; everything unknown is rejected up front
    let rule: Rule | undefined;
    let legacy: RulesV1['fields'];
    try {
      const parsed = this.rulesFor(ref, meta);
      rule = this.selectRule(req, parsed, target.origin, meta, mode, isBound);
      legacy = rule ? undefined : parsed.legacyFields;
    } catch (e) {
      const be = e as BlindfillError;
      audit({
        event: 'refused',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        reason: `${be.code}: ${be.message}`,
      });
      throw e;
    }
    const names = req.fields?.length
      ? req.fields
      : rule
        ? Object.keys(rule.fields)
        : ['username', 'password'];
    if (rule && req.fields?.some((n) => !(n in rule!.fields)))
      refuse(
        'field not in rule',
        new BlindfillError('NOT_FOUND', `rule "${rule.id}" does not map every requested field`),
      );
    type Kind = Step['kind'];
    const steps: Step[] = [];
    for (const name of names) {
      let kind: Kind;
      if (name === 'totp') {
        if (!meta.hasTotp || !this.backend.capabilities.has('TOTP'))
          refuse('no totp', new BlindfillError('NOT_FOUND', 'this item has no TOTP'));
        kind = 'totp';
      } else if (name === 'passkey' || name === 'ssh.privateKey')
        // private keys are used to sign (passkey) or not at all; never typed into a page or app
        return refuse(
          'private key',
          new BlindfillError('SECRET_ACCESS', `"${name}" is a private key: it is never typed into a field`),
        );
      else if (meta.secretFields.includes(name)) kind = 'secret';
      else if (name === 'username' ? !!meta.username : name in meta.readable) kind = 'readable';
      else
        return refuse(
          'unknown field',
          new BlindfillError('NOT_FOUND', 'item has no fillable field with that name'),
        );
      steps.push({ name, kind });
    }
    steps.sort(
      (x, y) => ({ readable: 0, totp: 1, secret: 2 })[x.kind] - { readable: 0, totp: 1, secret: 2 }[y.kind],
    );
    for (const st of steps.filter((x) => x.kind === 'secret')) {
      try {
        act.policy.assertFirstSecretFill(target.origin, st.name);
      } catch (e) {
        refuse('one-shot', e as BlindfillError);
      }
    }

    // 3. locate EVERY field (and the submit control) before reading ANY secret (fail closed)
    const locator =
      (name: string, role?: Role) =>
      async (ds?: Detected[]): Promise<Detected> => {
        if (rule) {
          const scope = await act.openRule(rule, isBound);
          return act.locateRule(scope, name);
        }
        const sel = legacy?.[name]?.selector;
        if (typeof sel === 'string') return act.locateBySelector(sel);
        const r = role ?? fieldRole(name);
        return act.locate(r ? { role: r } : { name }, ds);
      };
    try {
      const ds = rule ? undefined : await act.detectStable();
      const found: Record<string, Detected> = {};
      for (const st of steps) found[st.name] = await locator(st.name)(ds);
      if (!rule && ds) {
        const last = found[steps[steps.length - 1]?.name];
        if (found.password && typeof legacy?.password?.selector !== 'string')
          await act.assertGenericScope(found.password, found.username, ds);
        if (req.submit && last && meta.control.submit !== 'none') await act.checkSubmit(last, isBound);
      }
      if (opts.confirmField && rule && !rule.password_confirmation) await locator('confirm_password')(ds);
      if (req.submit && rule) await act.checkRuleSubmit(await act.openRule(rule, isBound), isBound);
      await act.bindDocument(Object.values(found).map((d) => d.frame));
    } catch (e) {
      const be = e as BlindfillError;
      audit({
        event: 'refused',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        reason: `${be.code}: ${be.message}`,
      });
      throw e;
    }
    return { act, target, tname, ref, meta, isBound, steps, rule, locator };
  }

  /** Value-free plan: what a fill would do. Reads no secret and touches no field. */
  async discover(
    req: FillRequest & { ruleOverride?: Rule; registration?: boolean },
  ): Promise<DiscoverResult> {
    this.actuator().policy.assertReadable('field discovery');
    const reg = req.registration === true;
    const p = await this.prepare(req, reg ? 'registration' : 'login', { confirmField: reg });
    audit({ event: 'probe', backend: this.backend.id, item: p.ref.id, target: p.tname, outcome: 'planned' });
    return {
      status: 'planned',
      origin: p.target.origin,
      item: { id: p.ref.id, name: p.meta.name },
      rule_id: p.rule?.id ?? null,
      fields: [
        ...p.steps.map((x) => x.name),
        ...(reg && p.rule && !p.rule.password_confirmation ? ['confirm_password'] : []),
      ],
      submit: 'not_attempted',
      submit_validated: !!(req.submit && p.rule),
      secrets_read: false,
    };
  }

  /** Value-free structural diagnosis of the page (and of the rule mapping when an item/rule is given). */
  async diagnose(req: ItemSelector & { rule?: string; url?: string; ruleOverride?: Rule }): Promise<unknown> {
    const act = this.actuator();
    act.policy.assertReadable('page diagnosis');
    if (req.url) await act.navigate(req.url);
    const { target, url } = act.identify();
    const ref = await this.resolveItem(req, target);
    const meta = await this.backend.meta(ref);
    const bind = checkWebBinding(url, meta);
    if (!bind.ok)
      throw new BlindfillError(
        'ORIGIN_MISMATCH',
        `refused: web:${target.origin} is not bound by this item (${bind.reason})`,
      );
    const isBound = (u: string) => checkWebBinding(u, meta).ok;
    let rule: Rule | undefined;
    if (req.rule || req.ruleOverride) {
      const parsed = this.rulesFor(ref, meta);
      const mode = (req.ruleOverride ?? parsed.rules.find((r) => r.id === req.rule))?.mode ?? 'login';
      rule = this.selectRule(req, parsed, target.origin, meta, mode, isBound);
    }
    const d = (await act.diagnose(rule)) as Record<string, unknown>;
    audit({
      event: 'probe',
      backend: this.backend.id,
      item: ref.id,
      target: `web:${target.origin}`,
      outcome: 'diagnosed',
    });
    return {
      status: 'completed',
      origin: target.origin,
      rule_id: rule?.id ?? null,
      diagnostics: d,
      values_exposed: false,
      attribute_values_exposed: false,
      secrets_read: false,
    };
  }

  /** Caller-supplied evidence only; never identity. Allowed after a fill (the lock does not block booleans). */
  async verify(req: { success: string; failure?: string }): Promise<unknown> {
    const act = this.actuator();
    if (!req.success?.trim() || (req.failure !== undefined && !req.failure.trim()))
      throw new BlindfillError('POLICY', 'verify needs a non-empty success selector');
    const r = await act.verify(req.success, req.failure);
    const outcome = !r.ambiguous && r.success !== r.failure ? (r.success ? 'success' : 'failure') : 'unknown';
    return {
      status: 'completed',
      login_outcome: outcome,
      success_evidence: r.success,
      failure_evidence: r.failure,
      identity_verified: false,
      verification: 'caller-supplied-page-evidence',
    };
  }

  /** Pages of the attached browser context (origin + path only). */
  pages(): unknown {
    return { status: 'completed', pages: this.rawActuator().listPages() };
  }

  /** Run a recipe: select one already-open page whose origin matches; no navigation, no new authority. */
  async runProfile(
    profile: Profile,
    opts: { check?: boolean; diagnose?: boolean; submit?: boolean; page?: number; expect?: Expect },
  ): Promise<unknown> {
    const base = this.actuator();
    const w = profile.doc.web;
    const pages = base
      .listPages()
      .filter((p) => p.origin === w.origin && (opts.page === undefined || p.index === opts.page));
    if (pages.length === 0)
      throw new BlindfillError(
        'NOT_FOUND',
        'no open page matches the recipe origin (profile_page_not_found)',
      );
    if (pages.length > 1)
      throw new BlindfillError(
        'AMBIGUOUS',
        `${pages.length} open pages match the recipe origin; pass --page <index> (profile_page_ambiguous)`,
      );
    const act = base.withPageIndex(pages[0].index);
    const e = new Engine(this.backend, act, this.persist);
    const ref: ItemRef = { backend: this.backend.id, id: profile.doc.item };
    const meta = await this.backend.meta(ref);
    if (profile.doc.item_name !== undefined && profile.doc.item_name !== meta.name)
      throw new BlindfillError('POLICY', 'profile_item_changed: the item name no longer matches the recipe');
    // the recipe never grants authority: the item's own URIs must bind the recipe origin
    if (!checkWebBinding(w.origin + '/', meta).ok)
      throw new BlindfillError(
        'ORIGIN_MISMATCH',
        'origin_not_allowed: the item does not bind the recipe origin',
      );
    let ruleOverride: Rule | undefined;
    let ruleId: string | undefined;
    if (typeof w.rule === 'string') ruleId = w.rule;
    else ruleOverride = w.rule;
    const submit = opts.submit ?? w.submit;
    const common = {
      item: ref.id,
      fields: w.fields,
      rule: ruleId,
      ruleOverride,
      submit,
      expect: opts.expect,
    };
    const tag = { page: pages[0].index, target: 'web', profile: profile.name, revision: profile.revision };
    if (opts.diagnose)
      return { ...((await e.diagnose({ item: ref.id, rule: ruleId, ruleOverride })) as object), ...tag };
    if (opts.check) return { ...(await e.discover(common)), ...tag };
    return { ...(await e.fill(common)), ...tag };
  }

  async fill(req: FillRequest & { ruleOverride?: Rule }): Promise<FillResult> {
    const p = await this.prepare(req, 'login');
    const { act, target, tname, ref, meta, isBound, steps, rule, locator } = p;
    const notes: string[] = [];

    // 4. fill
    const filled: string[] = [];
    let last: Detected | undefined;
    let wroteSecret = false;
    const guard = new SubmitGuard();
    try {
      for (const s of steps) {
        const relocate = () => locator(s.name)();
        if (s.kind === 'secret') {
          act.policy.lock(); // lock BEFORE the value leaves the backend, even if the fill then fails
          wroteSecret = true;
          this.persist();
          const handle = await this.backend.openSecret(ref, s.name);
          await handle.into(async (buf) => {
            const r = await act.fillInto(relocate, buf, isBound);
            last = r.last;
          });
          act.policy.recordSecretFill(target.origin, s.name);
        } else {
          const value =
            s.kind === 'totp'
              ? await this.backend.totpCode(ref)
              : s.name === 'username'
                ? (meta.username as string)
                : meta.readable[s.name];
          const r = await act.fillInto(relocate, value, isBound);
          if (s.kind !== 'totp' || !last) last = r.last;
        }
        filled.push(s.name);
      }
    } catch (e) {
      const be = e as BlindfillError;
      audit({
        event: 'fill',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        fields: filled,
        outcome: 'error',
        reason: globalScrubber.scrub(`${be.code ?? 'ERR'}: ${be.message}`),
      });
      throw e;
    } finally {
      this.persist();
    }

    audit({
      event: 'fill',
      backend: this.backend.id,
      item: ref.id,
      target: tname,
      fields: filled,
      outcome: 'ok',
    });

    // 5. optional single submit
    let submitted = false;
    let outcome: FillResult['outcome'] = 'not_submitted';
    let evidence: FillResult['evidence'];
    if (req.submit) {
      if (meta.control.submit === 'none') notes.push('item policy blindfill.submit=none: not submitted');
      else if (!last) notes.push('nothing was filled: not submitted');
      else {
        guard.take();
        const how = rule
          ? await act.submitRule(await act.openRule(rule, isBound), isBound)
          : await act.submit(last, isBound);
        submitted = true;
        audit({ event: 'submit', backend: this.backend.id, item: ref.id, target: tname, outcome: how });
        const ev = await act.evidence(req.expect);
        outcome = ev.outcome;
        evidence = { matched: ev.matched, url: ev.url };
        if (ev.outcome === 'unknown')
          notes.push('outcome unknown; blindfill does not retry. Check with your own evidence selectors.');
      }
    }
    if (wroteSecret)
      notes.push('session is locked: page text, DOM and screenshots are refused until session stop');
    return {
      origin: target.origin,
      item: { id: ref.id, name: meta.name },
      filled,
      locked: act.policy.locked,
      submitted,
      outcome,
      evidence,
      notes,
    };
  }

  /**
   * Account registration with an item that opted in (blindfill.registration=allow) and an explicit
   * registration rule. The stored password is read ONCE and typed into the password field and (unless the
   * rule says the form has none) the separate confirmation field; equality is checked inside the page and
   * only a boolean comes back. Fill-only unless submit=true; at most one submit; never retried.
   */
  async register(req: FillRequest & { rule: string; ruleOverride?: Rule }): Promise<RegisterResult> {
    this.actuator().policy.assertReadable('registration');
    if (!req.rule && !req.ruleOverride)
      throw new BlindfillError('POLICY', 'registration needs an explicit rule id (--rule)');
    if (req.fields)
      throw new BlindfillError('POLICY', 'registration fields come from the rule; do not pass fields');
    const act = this.actuator();
    const peek = await this.resolveForRegistration(req);
    if (!peek.meta.control.registration)
      throw new BlindfillError(
        'POLICY',
        'this item has not opted in to registration (custom field blindfill.registration=allow)',
      );
    const p = await this.prepare({ ...req, url: undefined, item: peek.ref.id }, 'registration', {
      confirmField: true,
    });
    const { target, tname, ref, meta, isBound, steps, rule, locator } = p;
    if (!rule) throw new BlindfillError('POLICY', 'registration needs a rule');
    if (
      !steps.some((x) => x.name === 'password') ||
      steps.find((x) => x.name === 'password')?.kind !== 'secret'
    )
      throw new BlindfillError('POLICY', 'registration needs a stored secret "password"');
    const confirm = !rule.password_confirmation;
    const scope0 = await act.openRule(rule, isBound);
    const want = confirm ? 2 : 1;
    if ((await act.passwordCount(scope0)) !== want)
      throw new BlindfillError(
        'POLICY',
        `unsafe form: the form has a different number of password fields than the rule maps (${want})`,
      );
    if (meta.control.passwordPolicy !== undefined) validatePasswordPolicy(meta.control.passwordPolicy);
    const notes: string[] = [];
    const filled: string[] = [];
    const guard = new SubmitGuard();
    let last: Detected | undefined;
    try {
      for (const s of steps) {
        if (s.kind === 'secret' && s.name === 'password') continue;
        const relocate = () => locator(s.name)();
        if (s.kind === 'secret') {
          act.policy.lock();
          this.persist();
          const h = await this.backend.openSecret(ref, s.name);
          await h.into(async (buf) => {
            last = (await act.fillInto(relocate, buf, isBound)).last;
          });
          act.policy.recordSecretFill(target.origin, s.name);
        } else {
          const value =
            s.kind === 'totp'
              ? await this.backend.totpCode(ref)
              : s.name === 'username'
                ? (meta.username as string)
                : meta.readable[s.name];
          last = (await act.fillInto(relocate, value, isBound)).last;
        }
        filled.push(s.name);
      }
      act.policy.lock(); // before the password leaves the backend
      this.persist();
      const handle = await this.backend.openSecret(ref, 'password');
      await handle.into(async (buf) => {
        if (
          meta.control.passwordPolicy !== undefined &&
          !passwordMatches(buf.toString('utf8'), meta.control.passwordPolicy as PasswordPolicy)
        )
          throw new BlindfillError(
            'POLICY',
            'the stored password does not meet the item password policy; nothing typed',
          );
        const r1 = await act.fillInto(() => locator('password')(), buf, isBound);
        last = r1.last;
        if (confirm) await act.fillInto(() => locator('confirm_password')(), buf, isBound);
      });
      act.policy.recordSecretFill(target.origin, 'password');
      filled.push('password');
      if (confirm) filled.push('confirm_password');
      if (confirm) {
        const a = await locator('password')();
        const b = await locator('confirm_password')();
        if (!(await act.sameValue(a, b)))
          throw new BlindfillError(
            'ACTUATOR',
            'the two password fields do not match after filling; nothing submitted',
          );
      }
    } catch (e) {
      const be = e as BlindfillError;
      audit({
        event: 'fill',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        fields: filled,
        outcome: 'error',
        reason: globalScrubber.scrub(`${be.code ?? 'ERR'}: ${be.message}`),
      });
      throw e;
    } finally {
      this.persist();
    }
    audit({
      event: 'fill',
      backend: this.backend.id,
      item: ref.id,
      target: tname,
      fields: filled,
      outcome: 'ok',
    });

    let submitted = false;
    let outcome: RegisterResult['registration_outcome'] = 'not_submitted';
    let evidence: FillResult['evidence'];
    if (req.submit) {
      if (meta.control.submit === 'none') notes.push('item policy blindfill.submit=none: not submitted');
      else {
        // re-verify immediately before the one submit
        const scope = await act.openRule(rule, isBound);
        if ((await act.passwordCount(scope)) !== want)
          throw new BlindfillError('POLICY', 'unsafe form: the form changed before submit');
        if (
          confirm &&
          !(await act.sameValue(await locator('password')(), await locator('confirm_password')()))
        )
          throw new BlindfillError('ACTUATOR', 'the password fields no longer match; nothing submitted');
        guard.take();
        const how = await act.submitRule(scope, isBound);
        submitted = true;
        audit({ event: 'submit', backend: this.backend.id, item: ref.id, target: tname, outcome: how });
        const ev = await act.evidence(req.expect);
        outcome = ev.outcome;
        evidence = { matched: ev.matched, url: ev.url };
        if (ev.outcome === 'unknown') notes.push('registration outcome unknown; blindfill never retries');
      }
    }
    void last;
    notes.push('session is locked: page text, DOM and screenshots are refused until session stop');
    return {
      origin: target.origin,
      item: { id: ref.id, name: meta.name },
      rule_id: rule.id,
      filled,
      locked: act.policy.locked,
      submitted,
      registration_outcome: outcome,
      evidence,
      notes,
    };
  }

  private async resolveForRegistration(
    req: ItemSelector & { url?: string },
  ): Promise<{ ref: ItemRef; meta: ItemMeta }> {
    const act = this.actuator();
    if (req.url) await act.navigate(req.url);
    const { target } = act.identify();
    const ref = await this.resolveItem(req, target);
    return { ref, meta: await this.backend.meta(ref) };
  }

  async fillTotp(req: Omit<FillRequest, 'fields'>): Promise<FillResult> {
    return this.fill({ ...req, fields: ['totp'] });
  }

  /**
   * Raise the vault's passkey counter after a signature (owner decision 2026-11-27: no terminal needed).
   * Never retried: a failure is audited and reported, and the next sign-in repeats the counter.
   */
  private async writeCounter(ref: ItemRef, credentialId: string, counter: number, target: string) {
    if (counter === 0) return { counter_written_back: false }; // Bitwarden semantics: 0 stays 0
    try {
      if (!this.backend.raisePasskeyCounter) throw new BlindfillError('UNSUPPORTED', 'no counter write');
      await this.backend.raisePasskeyCounter(ref, credentialId, counter);
      return { counter_written_back: true };
    } catch (e) {
      const code = e instanceof BlindfillError ? e.code : 'BACKEND';
      audit({
        event: 'passkey',
        backend: this.backend.id,
        item: ref.id,
        target,
        outcome: 'counter_write_failed',
        reason: code,
      });
      return { counter_written_back: false, counter_error: code };
    }
  }

  /**
   * Passkey sign-in (web: Chromium over CDP, Firefox/Camoufox over Marionette). Checks the item binding and the passkey's rpId against
   * the page before the key is read, then lets the page's own WebAuthn request use it once, then
   * writes the reported counter back to the vault.
   */
  async passkey(
    req: ItemSelector & { url?: string; click?: string; expect?: Expect },
  ): Promise<Record<string, unknown>> {
    const act = this.actuator();
    if (req.url) await act.navigate(req.url);
    const { target, url } = act.identify();
    const tname = formatTarget(target);
    const ref = await this.resolveItem(req, target);
    const meta = await this.backend.meta(ref);
    const refuse = (reason: string, err: BlindfillError): never => {
      audit({ event: 'refused', backend: this.backend.id, item: ref.id, target: tname, reason });
      throw err;
    };
    const bind = checkWebBinding(url, meta);
    if (!bind.ok)
      refuse(
        bind.reason,
        new BlindfillError('ORIGIN_MISMATCH', `refused: ${tname} is not bound by this item (${bind.reason})`),
      );
    if (!meta.secretFields.includes('passkey'))
      refuse('no passkey', new BlindfillError('NOT_FOUND', 'item has no passkey'));
    // WebAuthn lets any subdomain of rpId use it; blindfill also requires the page host to be inside rpId
    const rpId = meta.readable['passkey.rpId'] ?? '';
    const host = new URL(url).hostname;
    if (!rpId || (host !== rpId && !host.endsWith(`.${rpId}`)))
      refuse(
        'rpId mismatch',
        new BlindfillError('ORIGIN_MISMATCH', 'the passkey rpId does not cover this page'),
      );
    // Firefox cannot set BE; an RP that checks it against registration would reject a Bitwarden-made passkey
    if (act.passkeyRoute === 'marionette' && meta.control.passkeyBe)
      refuse(
        'backup-eligible passkey in Firefox',
        new BlindfillError(
          'POLICY',
          'this passkey was created backup-eligible (BE=1, as Bitwarden clients do) and Firefox can only sign with BE=0, which relying parties may reject: use Chromium, or a passkey registered through Firefox (blindfill.passkey_be=0)',
        ),
      );
    act.policy.assertFirstSecretFill(target.origin, 'passkey');
    act.policy.recordSecretFill(target.origin, 'passkey');
    this.persist();
    const h = await this.backend.openSecret(ref, 'passkey');
    const r = await act.passkeyAssert(h, { click: req.click, backupEligible: meta.control.passkeyBe });
    const ev = r.asserted && req.expect ? await act.evidence(req.expect) : undefined;
    audit({
      event: 'passkey',
      backend: this.backend.id,
      item: ref.id,
      target: tname,
      outcome: r.asserted ? 'asserted' : 'not_used',
    });
    return {
      status: r.asserted ? 'asserted' : 'not_used',
      origin: target.origin,
      item: { id: ref.id, name: meta.name },
      sign_count: r.signCount,
      ...(r.asserted && r.signCount !== null
        ? await this.writeCounter(ref, r.credentialId, r.signCount, tname)
        : { counter_written_back: false }),
      outcome: ev?.outcome ?? 'unknown',
    };
  }

  /**
   * Passkey registration (web: Chromium or Firefox/Camoufox), add only (owner decision 2026-11-27, no terminal):
   * the item must bind the page, have opted in (blindfill.registration=allow) and hold no passkey.
   * The page's own navigator.credentials.create() is answered once by an empty virtual authenticator;
   * the new key goes from the browser into the vault (one `bw edit`), never to the caller.
   */
  async passkeyRegister(
    req: ItemSelector & { url?: string; click?: string; expect?: Expect; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const act = this.actuator();
    if (req.url) await act.navigate(req.url);
    const { target, url } = act.identify();
    const tname = formatTarget(target);
    const ref = await this.resolveItem(req, target);
    const meta = await this.backend.meta(ref);
    const refuse = (reason: string, err: BlindfillError): never => {
      audit({ event: 'refused', backend: this.backend.id, item: ref.id, target: tname, reason });
      throw err;
    };
    const bind = checkWebBinding(url, meta);
    if (!bind.ok)
      refuse(
        bind.reason,
        new BlindfillError('ORIGIN_MISMATCH', `refused: ${tname} is not bound by this item (${bind.reason})`),
      );
    if (!meta.control.registration)
      refuse(
        'registration not allowed',
        new BlindfillError(
          'POLICY',
          'this item has not opted in to registration (custom field blindfill.registration=allow)',
        ),
      );
    if (meta.secretFields.includes('passkey'))
      refuse(
        'passkey exists',
        new BlindfillError(
          'POLICY',
          'the item already holds a passkey; replacing one needs a person at a terminal',
        ),
      );
    if (!this.backend.addPasskey)
      throw new BlindfillError('UNSUPPORTED', `${this.backend.id} cannot store passkeys`);
    act.policy.assertFirstSecretFill(target.origin, 'passkey-register');
    act.policy.recordSecretFill(target.origin, 'passkey-register');
    this.persist();
    const base = { origin: target.origin, item: { id: ref.id, name: meta.name } };
    const c = await act.passkeyCreate({ click: req.click, timeoutMs: req.timeoutMs });
    if (!c) {
      audit({
        event: 'passkey',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        outcome: 'not_created',
      });
      return { status: 'not_used', ...base, outcome: 'unknown' };
    }
    const created = {
      ...base,
      rp_id: c.rpId,
      credential_id: bwCredentialId(Buffer.from(c.credentialId, 'base64url')),
    };
    const orphan = 'the relying party may now hold a passkey the vault does not: delete it there';
    const host = new URL(url).hostname;
    // the browser already enforces this for WebAuthn; checked again before anything is stored
    const why =
      c.rpId !== host && !host.endsWith(`.${c.rpId}`)
        ? 'the created passkey rpId does not cover this page'
        : !c.es256
          ? 'only ES256 (P-256) passkeys can be stored'
          : undefined;
    if (why) {
      c.key.destroy();
      audit({ event: 'refused', backend: this.backend.id, item: ref.id, target: tname, reason: why });
      return { status: 'not_stored', ...created, reason: why, note: orphan };
    }
    try {
      await this.backend.addPasskey(ref, {
        credentialId: c.credentialId,
        rpId: c.rpId,
        userHandle: c.userHandle,
        userName: meta.username,
        counter: c.signCount,
        backupEligible: c.backupEligible,
        key: c.key,
      });
    } catch (e) {
      c.key.destroy();
      const code = e instanceof BlindfillError ? e.code : 'BACKEND';
      audit({
        event: 'passkey',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        outcome: 'vault_write_failed',
        reason: code,
      });
      return { status: 'vault_write_failed', ...created, error: code, note: orphan };
    }
    audit({ event: 'passkey', backend: this.backend.id, item: ref.id, target: tname, outcome: 'registered' });
    const ev = req.expect ? await act.evidence(req.expect) : undefined;
    return { status: 'registered', ...created, counter: c.signCount, outcome: ev?.outcome ?? 'unknown' };
  }

  /**
   * Android (companion APK): arm the phone for one fill. The phone reports the app asking (system
   * attested package + signer); the item must bind both (androidapp:// + blindfill.signers) before
   * any secret is read. kind=password: username+password go to the companion's autofill dataset.
   * kind=passkey: the host signs (key never leaves the host); the phone gets only the assertion.
   */
  async androidOffer(
    req: ItemSelector & { serial: string; kind: 'password' | 'passkey'; timeoutMs?: number },
    android = new AndroidActuator(),
  ): Promise<Record<string, unknown>> {
    const ref = await this.resolveItem(req);
    const meta = await this.backend.meta(ref);
    const pkgs = androidPackages(meta);
    if (pkgs.length === 0 || meta.control.signers.length === 0)
      throw new BlindfillError(
        'ORIGIN_MISMATCH',
        'item binds no Android app: it needs an androidapp://<package> URI and a blindfill.signers pin',
      );
    const field = req.kind === 'passkey' ? 'passkey' : 'password';
    if (!meta.secretFields.includes(field)) throw new BlindfillError('NOT_FOUND', `item has no ${field}`);
    const rpId = meta.readable['passkey.rpId'];
    let target = '';
    const refuse = (reason: string): never => {
      audit({
        event: 'refused',
        backend: this.backend.id,
        item: ref.id,
        target: target || 'android',
        reason,
      });
      throw new BlindfillError('ORIGIN_MISMATCH', `refused: ${reason}`);
    };
    let signed: { credentialId: string; count: number } | undefined;
    const r = await android.serve(
      {
        serial: req.serial,
        mode: req.kind,
        item: meta.name,
        user: meta.username,
        rpId,
        timeoutMs: req.timeoutMs,
      },
      async (p) => {
        target = formatTarget({ kind: 'android', pkg: p.pkg, signer: p.signer ?? undefined });
        if (p.kind !== req.kind) refuse('the phone answered a different request kind');
        if (p.web) refuse('a web page or WebView asked; use the web actuator for web logins');
        const bind = checkAndroidBinding(p.pkg, p.signer ?? undefined, meta);
        if (!bind.ok) refuse(bind.reason);
        if (req.kind === 'password') {
          if ((p.passwords ?? 0) !== 1 || p.newPassword)
            refuse('not a single-password login screen (sign-up or change-password)');
          let password = '';
          await (
            await this.backend.openSecret(ref, 'password')
          ).into((b) => {
            password = b.toString('utf8');
          });
          audit({
            event: 'fill',
            backend: this.backend.id,
            item: ref.id,
            target,
            fields: ['username', 'password'],
            outcome: 'offered',
          });
          return { username: meta.username ?? '', password };
        }
        if (!rpId || p.rpId !== rpId) refuse('the requested rpId is not the passkey rpId');
        const cdh = Buffer.from(String(p.clientDataHash ?? ''), 'base64url');
        if (cdh.length !== 32) refuse('malformed client data hash');
        let out: Record<string, unknown> = {};
        await (
          await this.backend.openSecret(ref, 'passkey')
        ).into((b) => {
          const c = JSON.parse(b.toString('utf8')) as BwFido2Credential;
          // counter rule (Bitwarden): a stored 0 stays 0, otherwise stored + 1, written back after
          const stored = Number(c.counter ?? 0) || 0;
          signed = { credentialId: c.credentialId ?? '', count: stored === 0 ? 0 : stored + 1 };
          const count = Buffer.alloc(4);
          count.writeUInt32BE(signed.count);
          // rpIdHash | flags UP+UV, plus BE+BS unless created without (as Bitwarden clients sign) | signCount
          const authData = Buffer.concat([
            createHash('sha256').update(rpId!).digest(),
            Buffer.from([meta.control.passkeyBe ? 0x1d : 0x05]),
            count,
          ]);
          const key = createPrivateKey({
            key: Buffer.from(c.keyValue ?? '', 'base64url'),
            format: 'der',
            type: 'pkcs8',
          });
          out = {
            authenticatorData: authData.toString('base64url'),
            signature: sign('sha256', Buffer.concat([authData, cdh]), key).toString('base64url'),
            credentialId: Buffer.from(credentialIdBase64(c.credentialId ?? ''), 'base64').toString(
              'base64url',
            ),
            userHandle: c.userHandle ?? '',
          };
        });
        audit({ event: 'passkey', backend: this.backend.id, item: ref.id, target, outcome: 'signed' });
        return out;
      },
    );
    if (r.status === 'refused')
      audit({
        event: 'refused',
        backend: this.backend.id,
        item: ref.id,
        target: target || 'android',
        reason: r.reason,
      });
    const answered = r.status === 'answered';
    return {
      status: answered ? (req.kind === 'passkey' ? 'signed' : 'offered') : r.status,
      ...(r.status === 'refused' ? { reason: r.reason } : {}),
      target: target || null,
      item: { id: ref.id, name: meta.name },
      ...(answered && signed
        ? {
            sign_count: signed.count,
            ...(await this.writeCounter(ref, signed.credentialId, signed.count, target)),
          }
        : {}),
      note:
        answered && req.kind === 'password'
          ? 'the phone shows a "blindfill: <item>" autofill suggestion; selecting it fills the fields'
          : undefined,
    };
  }

  async stop(): Promise<void> {
    await this.web?.close();
  }
}
