import type { Backend } from './backends/spi.js';
import { audit } from './core/audit.js';
import { checkWebBinding, SubmitGuard } from './core/policy.js';
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
import { passwordMatches, validatePasswordPolicy, type PasswordPolicy } from './password.js';

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

export class Engine {
  constructor(
    private backend: Backend,
    private web?: WebActuator,
    private persist: () => void = () => undefined,
  ) {}

  private actuator(): WebActuator {
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
      if (!rule) throw new BlindfillError('POLICY', `unknown rule "${req.rule}"`);
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
      } else if (meta.secretFields.includes(name)) kind = 'secret';
      else if (name === 'username' ? !!meta.username : name in meta.readable) kind = 'readable';
      else
        return refuse(
          'unknown field',
          new BlindfillError('NOT_FOUND', `item has no fillable field "${name}"`),
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
        if (typeof sel === 'string') return act.locateBySelector(sel, isBound);
        const r = role ?? fieldRole(name);
        return act.locate(r ? { role: r } : { name }, isBound, ds);
      };
    try {
      const ds = rule ? undefined : await act.detectStable();
      for (const st of steps) await locator(st.name)(ds);
      if (opts.confirmField && rule && !rule.password_confirmation) await locator('confirm_password')(ds);
      if (req.submit && rule) await act.checkRuleSubmit(await act.openRule(rule, isBound), isBound);
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
    return { status: 'completed', pages: this.actuator().listPages() };
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

  async stop(): Promise<void> {
    await this.web?.close();
  }
}
