import type { ElementHandle, Frame, JSHandle, Page } from 'playwright-core';
import { globalScrubber } from '../../core/scrubber.js';
import { SessionPolicy } from '../../core/policy.js';
import { BlindfillError, type WebTarget } from '../../core/types.js';
import { SecretHandle } from '../../core/secret.js';
import { createPrivateKey } from 'node:crypto';
import { credentialIdBase64, type BwFido2Credential } from '../../backends/bwmap.js';
import {
  DESCRIBE_FIELD,
  DIAGNOSE,
  PWD_COUNT,
  FORM_OF,
  FORM_SUBMITS,
  GENERIC_SCOPE,
  IS_FOCUSED,
  SAME_VALUE,
  VALUE_EQUALS,
} from './dom.js';
import {
  assertSubmitControl,
  clickRuleSubmit,
  locateInScope,
  openRuleScope,
  resolveRuleSubmit,
  type RuleScope,
} from './rulescope.js';
import type { Rule } from '../../rules.js';
import { pick, pickNamed, scoreRole, type FieldDescriptor, type Role } from './heuristics.js';
import { getProvider } from './providers/registry.js';
import type { ProviderCapabilities, ProviderConnection, ProviderOptions } from './providers/types.js';
import { assertLoopbackEndpoint } from './providers/util.js';
import { Marionette } from './marionette.js';

export { assertLoopbackEndpoint };

/** Per-page Chromium authenticator; BE=BS=1 because Bitwarden signs that way and RPs may reject a change of BE. */
const VIRTUAL_AUTHENTICATOR = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
  defaultBackupEligibility: true,
  defaultBackupState: true,
} as const;

/** A passkey a page just created. Everything but `key` is public data the RP already has. */
export interface CreatedPasskey {
  credentialId: string; // base64url
  rpId: string;
  userHandle: string; // base64url
  signCount: number;
  /** P-256 key: the only kind Bitwarden stores */
  es256: boolean;
  /** BE flag of the new passkey: true in Chromium (as Bitwarden), false in Firefox */
  backupEligible: boolean;
  /** PKCS#8 DER */
  key: SecretHandle;
}

/** Wrap a just-created private key (PKCS#8 DER) into a handle; `der` is zero-filled. */
function created(der: Buffer, pub: Omit<CreatedPasskey, 'es256' | 'key'>): CreatedPasskey {
  globalScrubber.register(der.toString('base64url'));
  globalScrubber.register(der.toString('base64'));
  const k = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const out = {
    ...pub,
    es256: k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1',
    key: new SecretHandle(der, 'passkey'),
  };
  der.fill(0);
  return out;
}

export interface Detected {
  desc: FieldDescriptor;
  handle: ElementHandle;
  frame: Frame;
  inTop: boolean;
  frameUrl: string;
}

/** Structure-only description of a field, safe to show an agent. Never a value. */
export interface CandidateInfo {
  ref: string;
  frame: 'top' | 'iframe';
  frameOrigin: string;
  type: string;
  name: string;
  id: string;
  label: string;
  autocomplete: string;
  guess: { role: Role; score: number } | null;
  usable: boolean;
  rejectedBecause: string[];
}

export interface ProbeResult {
  origin: string;
  url: string; // origin + path only
  title: string;
  candidates: CandidateInfo[];
  rejectedHidden: number;
  skippedFrames: number;
}

export interface Expect {
  urlIncludes?: string;
  urlRegex?: string;
  selector?: string;
  failSelector?: string;
  timeoutMs?: number;
}
export interface EvidenceResult {
  outcome: 'success' | 'failure' | 'unknown';
  matched: 'url' | 'selector' | 'failSelector' | null;
  url: string;
}

/** Selectors for outcome evidence must be structural; no value/text/pseudo probing (oracle hardening). */
export function assertSafeEvidenceSelector(sel: string): void {
  const outside = sel.replace(/\[[^\]]*\]/g, '');
  if (
    sel.length > 120 ||
    !/^[#.\w\-[\]="'>\s*~+,]+$/.test(sel) ||
    /value|\bon\w+=/i.test(sel) ||
    /[*~^$|]=/.test(sel) || // substring/word attribute matches probe content
    sel.includes('>>') ||
    /=|["']/.test(outside) // text= engines and quoted Playwright text selectors
  )
    throw new BlindfillError(
      'POLICY',
      'evidence selectors may only use tags, #id, .class and attribute equality (no :pseudo, text= or value probing)',
    );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Playwright errors can echo call logs; never let one through unscrubbed. */
function wrap(e: unknown, what: string): BlindfillError {
  if (e instanceof BlindfillError) return e;
  const first = String((e as Error)?.message ?? e).split('\n')[0];
  return new BlindfillError('ACTUATOR', `${what}: ${globalScrubber.scrub(first).slice(0, 160)}`);
}

export class WebActuator {
  readonly kind = 'web' as const;
  policy: SessionPolicy;
  readonly capabilities: ProviderCapabilities;
  readonly providerId: string;
  /** Documents bound by the last prepare (main frame + frames of located fields); fillInto never rebinds. */
  private bound: Map<Frame, JSHandle> | null = null;

  private constructor(
    public page: Page, // replaced only by navigate() on a shared context (conn.openPage)
    private conn: ProviderConnection | null,
    providerId: string,
    policy?: SessionPolicy,
    caps?: ProviderCapabilities,
  ) {
    this.policy = policy ?? new SessionPolicy();
    this.providerId = providerId;
    this.capabilities = conn?.capabilities ??
      caps ?? { evaluateIsolatedWorld: false, cdp: false, ownsBrowser: false, pagesSurviveDisconnect: true };
  }

  /** Generic entry: any registered browser provider (see docs/browsers.md). */
  static async fromProvider(providerId: string, opts: ProviderOptions = {}, policy?: SessionPolicy) {
    const conn = await getProvider(providerId).connect(opts);
    return new WebActuator(conn.page, conn, providerId, policy);
  }

  /** Mode 1: Playwright-launched browser (bundled Chromium or opts.executablePath / BLINDFILL_CHROMIUM). */
  static launch(opts: { headless?: boolean; executablePath?: string; policy?: SessionPolicy } = {}) {
    return WebActuator.fromProvider('chromium-launch', opts, opts.policy);
  }

  /** Mode 2: attach over CDP. Loopback endpoints only. */
  static connectCDP(
    endpoint: string,
    opts: { urlIncludes?: string; pageIndex?: number; policy?: SessionPolicy } = {},
  ) {
    return WebActuator.fromProvider('chromium-cdp', { ...opts, endpoint }, opts.policy);
  }

  /** Mode 2b: attach to a Playwright browser server (Firefox / Camoufox). Loopback only. */
  static connectFirefox(
    endpoint: string,
    opts: {
      urlIncludes?: string;
      pageIndex?: number;
      playwrightModule?: string;
      policy?: SessionPolicy;
    } = {},
  ) {
    return WebActuator.fromProvider('firefox-connect', { ...opts, endpoint }, opts.policy);
  }

  /** Mode 3: in-process Playwright Page owned by the caller (never closed by us). Any browser. */
  static fromPage(page: Page, policy?: SessionPolicy) {
    return new WebActuator(page, null, 'borrowed-page', policy);
  }

  /** Real identity as observed from the browser, never as claimed by the caller. */
  identify(): { target: WebTarget; url: string } {
    const url = this.page.url();
    if (!/^https?:\/\//i.test(url))
      throw new BlindfillError('ACTUATOR', 'the page is not an http(s) page; navigate first');
    return { target: { kind: 'web', origin: new URL(url).origin }, url };
  }

  async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) throw new BlindfillError('POLICY', 'only http(s) URLs can be opened');
    try {
      if (this.conn?.openPage) this.page = await this.conn.openPage(url);
      else await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) {
      throw wrap(e, 'navigation failed');
    }
  }

  // ---- guarded readers (post-fill lock) -------------------------------------------------

  async pageText(): Promise<string> {
    this.policy.assertReadable('page text');
    return globalScrubber.scrub(await this.page.innerText('body'));
  }
  async html(): Promise<string> {
    this.policy.assertReadable('DOM');
    return globalScrubber.scrub(await this.page.content());
  }
  async screenshot(): Promise<Buffer> {
    this.policy.assertReadable('screenshots');
    return this.page.screenshot();
  }

  // ---- detection ------------------------------------------------------------------------

  /** Rule-less detection: main frame only. Fields in child frames are reachable only through a rule. */
  async detect(): Promise<Detected[]> {
    const out: Detected[] = [];
    const frame = this.page.mainFrame();
    const frameUrl = frame.url();
    if (!/^https?:\/\//i.test(frameUrl)) return out;
    let handles: ElementHandle[];
    try {
      handles = (await frame.$$('input, textarea')).slice(0, 80);
    } catch {
      return out;
    }
    for (const handle of handles) {
      try {
        const desc = (await handle.evaluate(DESCRIBE_FIELD)) as FieldDescriptor;
        out.push({ desc, handle, frame, inTop: true, frameUrl });
      } catch {
        /* detached while scanning */
      }
    }
    return out;
  }

  private signature(ds: Detected[]): string {
    return ds
      .map((d) => [d.frameUrl, d.desc.type, d.desc.name, d.desc.id, d.desc.reasons.join('+')].join('|'))
      .join('\n');
  }

  /** Wait for a form to appear and stop changing (SPA render/re-render). */
  async detectStable(maxMs = 4000): Promise<Detected[]> {
    const deadline = Date.now() + maxMs;
    let prev = '';
    let stable = 0;
    let cur: Detected[] = [];
    while (Date.now() < deadline) {
      cur = await this.detect();
      const sig = this.signature(cur);
      const hasVisible = cur.some((d) => d.desc.reasons.length === 0);
      if (hasVisible && sig === prev) {
        if (++stable >= 2) return cur;
      } else stable = 0;
      prev = sig;
      await sleep(150);
    }
    return cur;
  }

  private info(d: Detected, i: number): CandidateInfo {
    let guess: CandidateInfo['guess'] = null;
    if (d.desc.reasons.length === 0)
      for (const role of ['password', 'username', 'totp'] as Role[]) {
        const s = scoreRole(d.desc, role);
        if (s > (guess?.score ?? 0)) guess = { role, score: s };
      }
    return {
      ref: `${d.inTop ? 'top' : 'frame'}:${i}`,
      frame: d.inTop ? 'top' : 'iframe',
      frameOrigin: new URL(d.frameUrl).origin,
      type: d.desc.type,
      name: d.desc.name,
      id: d.desc.id,
      label: d.desc.label,
      autocomplete: d.desc.autocomplete,
      guess,
      usable: d.desc.reasons.length === 0 && !d.desc.disabled && !d.desc.readOnly,
      rejectedBecause: d.desc.reasons,
    };
  }

  /** Structure only: refused after a secret fill. */
  async probe(): Promise<ProbeResult> {
    this.policy.assertReadable('page probe');
    const { target, url } = this.identify();
    const ds = await this.detectStable(2500);
    let title = '';
    try {
      title = (await this.page.title()).slice(0, 120);
    } catch {
      /* ignore */
    }
    const u = new URL(url);
    return {
      origin: target.origin,
      url: u.origin + u.pathname,
      title: globalScrubber.scrub(title),
      candidates: ds.map((d, i) => this.info(d, i)).filter((c) => c.usable || c.rejectedBecause.length),
      rejectedHidden: ds.filter((d) => d.desc.reasons.length > 0).length,
      skippedFrames: this.page.frames().length - 1,
    };
  }

  /** Choose the main-frame field for a role/name (rule-less path; child frames need a rule). */
  async locate(what: { role: Role } | { name: string }, ds?: Detected[]): Promise<Detected> {
    const all = ds ?? (await this.detectStable());
    const r = 'role' in what ? pick(all, what.role) : pickNamed(all, what.name);
    if (r.kind === 'ok') return r.item;
    const label = 'role' in what ? what.role : `"${what.name}"`;
    const names = this.policy.locked ? [] : all.map((d, i) => this.info(d, i)).filter((c) => c.usable);
    const framed =
      this.page.frames().length > 1
        ? '; fields inside frames are filled only through a blindfill.rules rule'
        : '';
    const msg =
      r.kind === 'ambiguous'
        ? `ambiguous ${label} field: ${r.items.length} similar candidates; not guessing`
        : `no confident ${label} field (best score ${r.best} < threshold)${framed}`;
    const e = new BlindfillError('AMBIGUOUS', msg) as BlindfillError & { candidates?: CandidateInfo[] };
    e.candidates = names;
    throw e;
  }

  /**
   * Locate a field by a legacy (v1) CSS selector from the vault item's blindfill.rules. Main frame only:
   * v1 selectors name no frame. The selector must match exactly one usable element.
   */
  async locateBySelector(selector: string): Promise<Detected> {
    const frame = this.page.mainFrame();
    const frameUrl = frame.url();
    const found: Detected[] = [];
    let hs: ElementHandle[];
    try {
      hs = await frame.$$(selector);
    } catch {
      throw new BlindfillError('POLICY', 'blindfill.rules contains an invalid selector');
    }
    for (const handle of hs) {
      const desc = (await handle.evaluate(DESCRIBE_FIELD)) as FieldDescriptor;
      if (desc.reasons.length === 0 && !desc.disabled && !desc.readOnly)
        found.push({ desc, handle, frame, inTop: true, frameUrl });
    }
    if (found.length !== 1)
      throw new BlindfillError(
        'AMBIGUOUS',
        `rule selector matched ${found.length} usable fields (need exactly 1)`,
      );
    return found[0];
  }

  /**
   * Raw text of the one main-frame element `selector` matches, for TOTP enrollment: an otpauth:// URI in
   * its href, value or text, else its value (inputs) or text. Returned to the engine only, never to a caller.
   * Main frame only, like v1 selectors: a key inside an iframe is not reachable.
   */
  async readSetupKey(selector: string): Promise<string> {
    let hs: ElementHandle<Element>[];
    try {
      hs = await this.page.mainFrame().$$(selector);
    } catch {
      throw new BlindfillError('POLICY', 'invalid selector');
    }
    if (hs.length !== 1)
      throw new BlindfillError(
        'AMBIGUOUS',
        `selector matched ${hs.length} elements in the top document (need exactly 1)`,
      );
    try {
      return await hs[0].evaluate((el) => {
        const v = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : null;
        const all = [el.getAttribute('href'), v, el.textContent];
        return all.find((s) => s && /otpauth:\/\//i.test(s)) ?? v ?? el.textContent ?? '';
      });
    } catch (e) {
      throw wrap(e, 'could not read the element');
    }
  }

  // ---- filling --------------------------------------------------------------------------

  private async fillOnce(d: Detected, value: string): Promise<'fill' | 'keys'> {
    const h = d.handle;
    try {
      await h.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      await h.fill(value, { timeout: 4000 });
      if ((await h.evaluate(VALUE_EQUALS, value)) === true) return 'fill';
    } catch (e) {
      if (
        /detached|not attached|Execution context|destroyed|Target closed/i.test(String((e as Error).message))
      )
        throw e;
      // fall through to the real key-event path
    }
    // fill() left the field empty/different: type with real key events.
    await h.focus();
    if ((await h.evaluate(IS_FOCUSED)) !== true)
      throw new BlindfillError('ACTUATOR', 'focus is not on the target field; refusing to type');
    await this.page.keyboard.press('ControlOrMeta+A');
    await this.page.keyboard.press('Backspace');
    await this.page.keyboard.type(value, { delay: 5 });
    if ((await h.evaluate(VALUE_EQUALS, value)) === true) return 'keys';
    await h.fill('').catch(() => undefined);
    throw new BlindfillError(
      'ACTUATOR',
      'field did not accept the value (verification failed); nothing submitted',
    );
  }

  /** Bind the current documents (main frame + `frames`) at the end of prepare. */
  async bindDocument(frames: Frame[]): Promise<void> {
    const old = this.bound;
    const m = new Map<Frame, JSHandle>();
    for (const f of new Set([this.page.mainFrame(), ...frames])) m.set(f, await f.evaluateHandle('document'));
    this.bound = m;
    for (const h of old?.values() ?? []) await h.dispose().catch(() => undefined);
  }

  /**
   * The field must live in the document bound at prepare, and the main frame must still show its bound
   * document. A cross-document navigation (same-origin included) or a replaced frame invalidates the
   * handle's execution context, so the comparison throws and we refuse. pushState keeps the document.
   */
  private async assertBoundDocument(d: Detected): Promise<void> {
    const top = this.page.mainFrame();
    const topDoc = this.bound?.get(top);
    const fieldDoc = this.bound?.get(d.frame);
    const same =
      !!topDoc &&
      !!fieldDoc &&
      !d.frame.isDetached() &&
      (await top.evaluate((doc) => doc === document, topDoc).catch(() => false)) &&
      (await d.handle.evaluate((el, doc) => el.ownerDocument === doc, fieldDoc).catch(() => false));
    if (!same)
      throw new BlindfillError(
        'ACTUATOR',
        'the page navigated or a frame was replaced after the fill was prepared; refusing to type',
      );
  }

  /**
   * Write a value into the field chosen by `relocate`, verifying exact content, surviving one SPA
   * re-render, and re-checking origin binding immediately before typing. Throws; never returns the value.
   */
  async fillInto(
    relocate: () => Promise<Detected>,
    value: Buffer | string,
    isBound: (url: string) => boolean,
  ): Promise<{ method: 'fill' | 'keys'; last: Detected }> {
    const str = typeof value === 'string' ? value : value.toString('utf8');
    // a string is readable (username, plain field) or a TOTP code the caller registered; scrubbing a
    // username withheld every output that named the item (ig-<username>)
    if (typeof value !== 'string') globalScrubber.register(str);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await relocate();
      if (!isBound(this.page.url()) || !isBound(d.frameUrl))
        throw new BlindfillError(
          'ORIGIN_MISMATCH',
          'the page changed to an origin the item does not bind; refusing to type',
        );
      await this.assertBoundDocument(d);
      try {
        const method = await this.fillOnce(d, str);
        await sleep(160); // SPA frameworks may re-render and wipe the value right after input
        if ((await d.handle.evaluate(VALUE_EQUALS, str)) === true) return { method, last: d };
        lastErr = new Error('value was reset by the page');
      } catch (e) {
        if (e instanceof BlindfillError) throw e;
        lastErr = e;
      }
      await sleep(300);
    }
    throw wrap(lastErr, 'fill failed');
  }

  /**
   * Rule-less form choice: the password and username must share one form owner, and the
   * page must offer exactly one plausible login form. Sign-up / change-password / confirm pages refuse.
   * Messages never echo page or caller input.
   */
  async assertGenericScope(pwd: Detected, user: Detected | undefined, ds: Detected[]): Promise<void> {
    const vis = ds.filter((d) => d.desc.type === 'password' && d.desc.reasons.length === 0);
    const same = vis.filter((d) => d.frame === pwd.frame);
    const code = await pwd.handle.evaluate(GENERIC_SCOPE, {
      pwds: same.map((d) => d.handle),
      otherFrames: vis.length - same.length,
      user: user && user.frame === pwd.frame ? user.handle : null,
    });
    const split = code === 'ok' && user !== undefined && user.frame !== pwd.frame;
    const msg: Record<string, string> = {
      new_password: 'the password field is marked new-password (sign-up or change-password page)',
      multi_password:
        'the page has several visible password fields or forms (sign-up, change-password or ambiguous)',
      split: 'the username and password fields are not in the same form',
    };
    if (code !== 'ok' || split)
      throw new BlindfillError(
        'POLICY',
        `unsafe form: ${msg[split ? 'split' : code]}; add a blindfill.rules rule to fill it`,
      );
  }

  /** Rule-less submit: exactly one visible native submit of the field's own form, POST, _self, bound action. */
  private async resolveGenericSubmit(
    near: Detected,
    isBound: (url: string) => boolean,
    precheck = false,
  ): Promise<ElementHandle> {
    const form = (await near.handle.evaluateHandle(FORM_OF)).asElement();
    if (!form)
      throw new BlindfillError(
        'POLICY',
        'unsafe form: the field is not inside a <form>; submit refused without a rule (add a blindfill.rules rule with a submit control)',
      );
    const list = await form.evaluateHandle(FORM_SUBMITS);
    const n = (await (await list.getProperty('length')).jsonValue()) as number;
    if (n !== 1)
      throw new BlindfillError(
        'POLICY',
        `unsafe form: expected exactly one visible submit button in the form, found ${n}; submit refused (add a blindfill.rules rule)`,
      );
    const submitter = (await list.getProperty('0')).asElement();
    if (!submitter) throw new BlindfillError('NOT_FOUND', 'submit control vanished');
    await assertSubmitControl(submitter, form, true, 'native', near.frameUrl, isBound, precheck);
    return submitter;
  }

  /** Validate (no click): lets the engine refuse before any secret is read. A disabled submit passes here. */
  async checkSubmit(near: Detected, isBound: (url: string) => boolean): Promise<void> {
    await this.resolveGenericSubmit(near, isBound, true);
  }

  /** Click the single validated native submit of `near`'s form. */
  async submit(near: Detected, isBound: (url: string) => boolean): Promise<'click'> {
    try {
      const h = await this.resolveGenericSubmit(near, isBound);
      await h.click({ timeout: 3000 });
      return 'click';
    } catch (e) {
      throw wrap(e, 'submit failed');
    }
  }

  // ---- explicit rules ---------------------------------------------------------------------

  openRule(rule: Rule, isBound: (url: string) => boolean): Promise<RuleScope> {
    return openRuleScope(this.page, rule, isBound);
  }
  locateRule(scope: RuleScope, name: string): Promise<Detected> {
    return locateInScope(scope, name);
  }
  async checkRuleSubmit(scope: RuleScope, isBound: (url: string) => boolean): Promise<void> {
    await resolveRuleSubmit(scope, isBound, true);
  }
  async passwordCount(scope: RuleScope): Promise<number> {
    return scope.group.evaluate(PWD_COUNT, { native: scope.native });
  }
  /** Validate + click the rule's submit control once. */
  async submitRule(scope: RuleScope, isBound: (url: string) => boolean): Promise<'click'> {
    try {
      const submitter = await resolveRuleSubmit(scope, isBound);
      await clickRuleSubmit(this.page, scope, submitter, async () => {
        await resolveRuleSubmit(scope, isBound); // re-validate with the guard installed
      });
      return 'click';
    } catch (e) {
      throw wrap(e, 'submit failed');
    }
  }
  /** Registration: both password fields hold the same non-empty value. Returns only a boolean. */
  async sameValue(a: Detected, b: Detected): Promise<boolean> {
    try {
      return (await a.handle.evaluate(SAME_VALUE, b.handle)) === true;
    } catch {
      return false;
    }
  }

  // ---- pages and value-free inspection ------------------------------------------------------

  /** Pages of the attached context: index, origin and path only (never query, fragment or title). */
  listPages(): { index: number; origin: string; path: string; current: boolean }[] {
    return this.page
      .context()
      .pages()
      .map((p, index) => {
        let origin = '';
        let path = '';
        try {
          const u = new URL(p.url());
          if (/^https?:$/.test(u.protocol)) {
            origin = u.origin;
            path = u.pathname;
          } else origin = u.protocol;
        } catch {
          /* blank */
        }
        return { index, origin, path: globalScrubber.scrub(path), current: p === this.page };
      });
  }

  /** A sibling actuator on another page of the same context; shares the policy (lock/one-shot). */
  withPageIndex(index: number): WebActuator {
    const p = this.page.context().pages()[index];
    if (!p) throw new BlindfillError('NOT_FOUND', `no page with index ${index}`);
    return p === this.page ? this : WebActuator.fromPage(p, this.policy);
  }

  /** Bounded structural diagnosis: no values, no raw attribute text, no labels. */
  async diagnose(rule?: Rule): Promise<unknown> {
    this.policy.assertReadable('page diagnosis');
    const kinds: Record<string, string> = {
      password: 'password',
      confirm_password: 'password',
      totp: 'totp',
    };
    const frame = rule?.frame ? null : this.page.mainFrame();
    let target = frame;
    if (!target && rule?.frame) {
      const o = rule.frame.origin;
      const sameOrigin = (u: string) => {
        try {
          return new URL(u).origin === o; // a prefix test would accept https://a.com.evil.net
        } catch {
          return false;
        }
      };
      target = this.page.frames().find((f) => f !== this.page.mainFrame() && sameOrigin(f.url())) ?? null;
    }
    if (!target) throw new BlindfillError('NOT_FOUND', 'the rule frame is not present');
    const doc = await target.evaluateHandle('document');
    const r = (await doc.evaluate(DIAGNOSE, { rule: rule ?? null, kinds })) as { total: number };
    return { ...r, truncated: r.total > 80 };
  }

  /** Caller-selected unique visible evidence; booleans only. Allowed while locked. */
  async verify(
    successSelector: string,
    failureSelector?: string,
  ): Promise<{ success: boolean; failure: boolean; ambiguous: boolean }> {
    assertSafeEvidenceSelector(successSelector);
    if (failureSelector) assertSafeEvidenceSelector(failureSelector);
    const one = async (sel: string): Promise<[boolean, boolean]> => {
      try {
        const loc = this.page.locator(sel);
        const count = await loc.count();
        return [count === 1 && (await loc.isVisible()), count > 1];
      } catch (e) {
        throw wrap(e, 'verify'); // Playwright parse errors echo the selector
      }
    };
    const [s, sa] = await one(successSelector);
    const [f, fa] = failureSelector ? await one(failureSelector) : [false, false];
    return { success: s, failure: f, ambiguous: sa || fa };
  }

  /** Outcome evidence from caller-specified URL/selectors. Returns booleans/enums, never page content. */
  async evidence(spec: Expect | undefined): Promise<EvidenceResult> {
    const u = () => {
      try {
        const x = new URL(this.page.url());
        return globalScrubber.scrub(x.origin + x.pathname);
      } catch {
        return '';
      }
    };
    if (!spec || (!spec.urlIncludes && !spec.urlRegex && !spec.selector && !spec.failSelector))
      return { outcome: 'unknown', matched: null, url: u() };
    for (const s of [spec.selector, spec.failSelector]) if (s) assertSafeEvidenceSelector(s);
    let re: RegExp | undefined;
    if (spec.urlRegex) {
      try {
        re = new RegExp(spec.urlRegex);
      } catch {
        throw new BlindfillError('POLICY', 'invalid urlRegex');
      }
    }
    const deadline = Date.now() + Math.min(spec.timeoutMs ?? 6000, 30_000);
    while (true) {
      try {
        if (spec.failSelector && (await this.page.locator(spec.failSelector).first().isVisible()))
          return { outcome: 'failure', matched: 'failSelector', url: u() };
        if (spec.selector && (await this.page.locator(spec.selector).first().isVisible()))
          return { outcome: 'success', matched: 'selector', url: u() };
        const cur = this.page.url();
        // match against origin+path, never against query/fragment content
        const x = new URL(cur);
        const shown = x.origin + x.pathname;
        if ((spec.urlIncludes && shown.includes(spec.urlIncludes)) || (re && re.test(shown)))
          return { outcome: 'success', matched: 'url', url: u() };
      } catch {
        /* navigation in flight: retry */
      }
      if (Date.now() > deadline) return { outcome: 'unknown', matched: null, url: u() };
      await sleep(150);
    }
  }

  /** How this browser can hold a passkey: Chromium over CDP, Firefox/Camoufox over Marionette, or not. */
  get passkeyRoute(): 'cdp' | 'marionette' | null {
    return this.capabilities.cdp ? 'cdp' : this.conn?.marionette ? 'marionette' : null;
  }

  private passkeyRouteOrThrow(): 'cdp' | 'marionette' {
    const r = this.passkeyRoute;
    if (!r)
      throw new BlindfillError(
        'UNSUPPORTED',
        'passkeys need a Chromium provider with CDP, or firefox-connect with a Marionette endpoint (BLINDFILL_MARIONETTE)',
      );
    return r;
  }

  /**
   * Passkey sign-in (ARCHITECTURE 3.8): the credential is loaded into a virtual authenticator (Chromium:
   * per page over CDP; Firefox: browser-wide over Marionette), the page's own
   * navigator.credentials.get() uses it, and it is removed after the first assertion or the timeout.
   * The private key goes handle -> browser; the page and the caller never receive it.
   * `backupEligible` (Chromium only) is the BE flag the passkey was created with; Firefox signs BE=0.
   */
  async passkeyAssert(
    handle: SecretHandle,
    opts: { click?: string; timeoutMs?: number; backupEligible?: boolean } = {},
  ): Promise<{ asserted: boolean; signCount: number | null; credentialId: string }> {
    const route = this.passkeyRouteOrThrow();
    if (opts.click) assertSafeEvidenceSelector(opts.click);
    if (route === 'marionette') return this.marionetteAssert(handle, opts);
    const cdp = await this.page.context().newCDPSession(this.page);
    let authenticatorId: string | undefined;
    let credentialId = '';
    try {
      await cdp.send('WebAuthn.enable', { enableUI: false });
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: VIRTUAL_AUTHENTICATOR,
      }));
      const asserted = new Promise<number>((res) =>
        cdp.on('WebAuthn.credentialAsserted', (e) => res(e.credential.signCount)),
      );
      await handle.into(async (buf) => {
        const c = JSON.parse(buf.toString('utf8')) as BwFido2Credential;
        credentialId = c.credentialId ?? '';
        await cdp.send('WebAuthn.addCredential', {
          authenticatorId: authenticatorId!,
          credential: {
            credentialId: credentialIdBase64(credentialId),
            isResidentCredential: true,
            rpId: c.rpId ?? '',
            privateKey: Buffer.from(c.keyValue ?? '', 'base64url').toString('base64'),
            userHandle: c.userHandle ? Buffer.from(c.userHandle, 'base64url').toString('base64') : undefined,
            // Chromium reports signCount + 1 (never 0); the engine writes that back
            signCount: Number(c.counter ?? 0) || 0,
            backupEligibility: opts.backupEligible ?? true,
            backupState: opts.backupEligible ?? true,
          },
        });
      });
      if (opts.click) await this.page.locator(opts.click).click({ timeout: 5000 });
      const n = await Promise.race([asserted, sleep(opts.timeoutMs ?? 15_000).then(() => null)]);
      return { asserted: n !== null, signCount: n, credentialId };
    } catch (e) {
      throw wrap(e, 'passkey');
    } finally {
      if (authenticatorId)
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }

  /**
   * Firefox: Marionette has no assertion event, so the authenticator is polled until the credential's
   * counter moves. Firefox signs with the stored count, then counts up: adding stored + 1 (0 stays 0,
   * Bitwarden's rule) makes it report what Chromium and the Android host report.
   */
  private async marionetteAssert(
    handle: SecretHandle,
    opts: { click?: string; timeoutMs?: number },
  ): Promise<{ asserted: boolean; signCount: number | null; credentialId: string }> {
    const m = await Marionette.open(this.conn!.marionette!);
    let credentialId = '';
    try {
      const authenticatorId = await m.addAuthenticator();
      let added = 0;
      await handle.into(async (buf) => {
        const c = JSON.parse(buf.toString('utf8')) as BwFido2Credential;
        credentialId = c.credentialId ?? '';
        const stored = Number(c.counter ?? 0) || 0;
        added = stored === 0 ? 0 : stored + 1;
        await m.cmd('WebAuthn:AddCredential', {
          authenticatorId,
          credentials: {
            credentialId: Buffer.from(credentialIdBase64(credentialId), 'base64').toString('base64url'),
            isResidentCredential: true,
            rpId: c.rpId ?? '',
            privateKey: c.keyValue ?? '',
            userHandle: c.userHandle || undefined,
            signCount: added,
          },
        });
      });
      // Firefox serves WebAuthn only to the focused document
      await this.page.bringToFront();
      if (opts.click) await this.page.locator(opts.click).click({ timeout: 5000 });
      const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
      while (Date.now() < deadline) {
        const [c] = await m.credentials();
        if (c && c.signCount > added) return { asserted: true, signCount: added, credentialId };
        await sleep(200);
      }
      return { asserted: false, signCount: null, credentialId };
    } catch (e) {
      throw wrap(e, 'passkey');
    } finally {
      await m.close();
    }
  }

  /**
   * Passkey registration (ARCHITECTURE 3.8): an empty virtual authenticator answers the page's own
   * navigator.credentials.create() once and is removed. The new private key comes back from the
   * browser only inside the returned handle (registered with the scrubber first); the caller and
   * the page never receive it.
   */
  async passkeyCreate(opts: { click?: string; timeoutMs?: number } = {}): Promise<CreatedPasskey | null> {
    const route = this.passkeyRouteOrThrow();
    if (opts.click) assertSafeEvidenceSelector(opts.click);
    if (route === 'marionette') return this.marionetteCreate(opts);
    const cdp = await this.page.context().newCDPSession(this.page);
    let authenticatorId: string | undefined;
    try {
      await cdp.send('WebAuthn.enable', { enableUI: false });
      ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: VIRTUAL_AUTHENTICATOR,
      }));
      const added = new Promise<CreatedPasskey>((res) =>
        cdp.on('WebAuthn.credentialAdded', ({ credential: c }) => {
          globalScrubber.register(c.privateKey);
          res(
            created(Buffer.from(c.privateKey, 'base64'), {
              credentialId: Buffer.from(c.credentialId, 'base64').toString('base64url'),
              rpId: c.rpId ?? '',
              userHandle: Buffer.from(c.userHandle ?? '', 'base64').toString('base64url'),
              signCount: c.signCount,
              backupEligible: true,
            }),
          );
        }),
      );
      // Bitwarden stores only ES256 keys: for the next create() act like an ES256-only authenticator,
      // which picks -7 from the page's list (webauthn.io lists Ed25519 first, which Chromium would take)
      await this.page.evaluate(() => {
        const c = navigator.credentials;
        const create = c.create.bind(c);
        c.create = (o) => {
          c.create = create;
          const p = o?.publicKey;
          if (p?.pubKeyCredParams.some((x) => x.alg === -7))
            p.pubKeyCredParams = p.pubKeyCredParams.filter((x) => x.alg === -7);
          return create(o);
        };
      });
      if (opts.click) await this.page.locator(opts.click).click({ timeout: 5000 });
      return await Promise.race([added, sleep(opts.timeoutMs ?? 15_000).then(() => null)]);
    } catch (e) {
      throw wrap(e, 'passkey');
    } finally {
      if (authenticatorId)
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }

  /**
   * Firefox: polls the empty authenticator until the page's create() put a credential in it. Firefox
   * cannot set the backup-eligible flag, so the passkey is BE=0 (stored as blindfill.passkey_be=0).
   */
  private async marionetteCreate(opts: {
    click?: string;
    timeoutMs?: number;
  }): Promise<CreatedPasskey | null> {
    const m = await Marionette.open(this.conn!.marionette!);
    try {
      await m.addAuthenticator();
      await this.page.bringToFront();
      if (opts.click) await this.page.locator(opts.click).click({ timeout: 5000 });
      const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
      while (Date.now() < deadline) {
        const [c] = await m.credentials();
        if (c)
          return created(Buffer.from(c.privateKey, 'base64url'), {
            credentialId: c.credentialId,
            rpId: c.rpId,
            userHandle: c.userHandle ?? '',
            signCount: c.signCount,
            backupEligible: false,
          });
        await sleep(200);
      }
      return null;
    } catch (e) {
      throw wrap(e, 'passkey');
    } finally {
      await m.close();
    }
  }

  async close(): Promise<void> {
    if (this.conn) await this.conn.close();
  }
}
