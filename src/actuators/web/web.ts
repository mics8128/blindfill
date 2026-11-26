import { chromium, type Browser, type ElementHandle, type Frame, type Page } from 'playwright-core';
import { globalScrubber } from '../../core/scrubber.js';
import { SessionPolicy } from '../../core/policy.js';
import { BlindfillError, type WebTarget } from '../../core/types.js';
import { DESCRIBE_FIELD, FIND_SUBMIT, IS_FOCUSED, VALUE_EQUALS } from './dom.js';
import {
  pick,
  pickNamed,
  scoreRole,
  type FieldDescriptor,
  type Pick,
  type Role,
} from './heuristics.js';

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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export function assertLoopbackEndpoint(endpoint: string): void {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new BlindfillError('ACTUATOR', 'invalid CDP endpoint');
  }
  if (!['http:', 'ws:'].includes(u.protocol) || !LOOPBACK.has(u.hostname))
    throw new BlindfillError('ACTUATOR', 'CDP endpoint must be a loopback address (127.0.0.1, localhost, ::1)');
}

/** Selectors for outcome evidence must be structural; no value/text/pseudo probing (oracle hardening). */
export function assertSafeEvidenceSelector(sel: string): void {
  if (sel.length > 120 || !/^[#.\w\-[\]="'>\s*~+,]+$/.test(sel) || /value|\bon\w+=/i.test(sel))
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

  private constructor(
    readonly page: Page,
    private browser: Browser | null,
    private ownsBrowser: boolean,
    policy?: SessionPolicy,
  ) {
    this.policy = policy ?? new SessionPolicy();
  }

  /** Mode 1: Playwright-launched browser (bundled Chromium). */
  static async launch(opts: { headless?: boolean; executablePath?: string; policy?: SessionPolicy } = {}) {
    const browser = await chromium.launch({
      headless: opts.headless ?? true,
      executablePath: opts.executablePath,
    });
    const page = await (await browser.newContext()).newPage();
    return new WebActuator(page, browser, true, opts.policy);
  }

  /** Mode 2: attach over CDP. Loopback endpoints only. */
  static async connectCDP(
    endpoint: string,
    opts: { urlIncludes?: string; pageIndex?: number; policy?: SessionPolicy } = {},
  ) {
    assertLoopbackEndpoint(endpoint);
    const browser = await chromium.connectOverCDP(endpoint);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    let pages = ctx.pages();
    if (pages.length === 0) pages = [await ctx.newPage()];
    let page: Page | undefined;
    if (opts.pageIndex !== undefined) page = pages[opts.pageIndex];
    else if (opts.urlIncludes) page = pages.find((p) => p.url().includes(opts.urlIncludes!));
    else page = [...pages].reverse().find((p) => /^https?:/.test(p.url())) ?? pages[pages.length - 1];
    if (!page) throw new BlindfillError('ACTUATOR', 'no matching page in the attached browser');
    return new WebActuator(page, browser, false, opts.policy);
  }

  /** Mode 3: in-process Playwright Page owned by the caller (never closed by us). */
  static fromPage(page: Page, policy?: SessionPolicy) {
    return new WebActuator(page, null, false, policy);
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
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
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

  async detect(): Promise<Detected[]> {
    const out: Detected[] = [];
    const top = this.page.mainFrame();
    for (const frame of this.page.frames()) {
      const frameUrl = frame.url();
      if (!/^https?:\/\//i.test(frameUrl)) continue;
      let handles: ElementHandle[] = [];
      try {
        handles = (await frame.$$('input, textarea')).slice(0, 80);
      } catch {
        continue;
      }
      for (const handle of handles) {
        try {
          const desc = (await handle.evaluate(DESCRIBE_FIELD)) as FieldDescriptor;
          out.push({ desc, handle, frame, inTop: frame === top, frameUrl });
        } catch {
          /* detached while scanning */
        }
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
      skippedFrames: this.page.frames().filter((f) => !/^https?:/i.test(f.url()) && f !== this.page.mainFrame()).length,
    };
  }

  /**
   * Choose the field for a role/name. `isBound(url)` answers whether the vault item binds that URL.
   * Fields in cross-origin frames the item does not bind are never chosen (refused loudly).
   */
  async locate(
    what: { role: Role } | { name: string },
    isBound: (url: string) => boolean,
    ds?: Detected[],
    allowNames = true,
  ): Promise<Detected> {
    const all = ds ?? (await this.detectStable());
    const topOrigin = new URL(this.page.url()).origin;
    const allowed = all.filter((d) => d.inTop || new URL(d.frameUrl).origin === topOrigin || isBound(d.frameUrl));
    const run = (set: Detected[]): Pick<Detected> =>
      'role' in what ? pick(set, what.role) : pickNamed(set, what.name);
    const label = 'role' in what ? what.role : `"${what.name}"`;
    const r = run(allowed);
    if (r.kind === 'ok') return r.item;
    if (r.kind === 'none') {
      const u = run(all);
      if (u.kind === 'ok' && !allowed.includes(u.item))
        throw new BlindfillError(
          'ORIGIN_MISMATCH',
          `the ${label} field is inside a cross-origin frame (${new URL(u.item.frameUrl).origin}) that the vault item does not bind: refused`,
        );
    }
    const names = this.policy.locked ? [] : all.map((d, i) => this.info(d, i)).filter((c) => c.usable);
    const msg =
      r.kind === 'ambiguous'
        ? `ambiguous ${label} field: ${r.items.length} similar candidates; not guessing`
        : `no confident ${label} field (best score ${r.best} < threshold)`;
    const e = new BlindfillError('AMBIGUOUS', msg) as BlindfillError & { candidates?: CandidateInfo[] };
    e.candidates = names;
    throw e;
  }

  /**
   * Locate a field by an explicit CSS selector from the vault item's blindfill.rules.
   * Only frames the item binds are searched; the selector must match exactly one usable element.
   */
  async locateBySelector(selector: string, isBound: (url: string) => boolean): Promise<Detected> {
    const top = this.page.mainFrame();
    const topOrigin = new URL(this.page.url()).origin;
    const found: Detected[] = [];
    for (const frame of this.page.frames()) {
      const frameUrl = frame.url();
      if (!/^https?:\/\//i.test(frameUrl)) continue;
      const inTop = frame === top;
      if (!inTop && new URL(frameUrl).origin !== topOrigin && !isBound(frameUrl)) continue;
      let hs: ElementHandle[] = [];
      try {
        hs = await frame.$$(selector);
      } catch {
        throw new BlindfillError('POLICY', 'blindfill.rules contains an invalid selector');
      }
      for (const handle of hs) {
        const desc = (await handle.evaluate(DESCRIBE_FIELD)) as FieldDescriptor;
        if (desc.reasons.length === 0 && !desc.disabled && !desc.readOnly) found.push({ desc, handle, frame, inTop, frameUrl });
      }
    }
    if (found.length !== 1)
      throw new BlindfillError('AMBIGUOUS', `rule selector matched ${found.length} usable fields (need exactly 1)`);
    return found[0];
  }

  // ---- filling --------------------------------------------------------------------------

  private async fillOnce(d: Detected, value: string): Promise<'fill' | 'keys'> {
    const h = d.handle;
    try {
      await h.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      await h.fill(value, { timeout: 4000 });
      if ((await h.evaluate(VALUE_EQUALS, value)) === true) return 'fill';
    } catch (e) {
      if (/detached|not attached|Execution context|destroyed|Target closed/i.test(String((e as Error).message))) throw e;
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
    throw new BlindfillError('ACTUATOR', 'field did not accept the value (verification failed); nothing submitted');
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
    globalScrubber.register(str);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await relocate();
      if (!isBound(this.page.url()) || !isBound(d.frameUrl))
        throw new BlindfillError('ORIGIN_MISMATCH', 'the page changed to an origin the item does not bind; refusing to type');
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

  /** Click the submit control next to `near` (or press Enter). Returns what was done. */
  async submit(near: Detected): Promise<'click' | 'enter'> {
    try {
      const h = (await near.handle.evaluateHandle(FIND_SUBMIT)).asElement() as ElementHandle | null;
      if (h) {
        await h.click({ timeout: 3000 });
        return 'click';
      }
      await near.handle.press('Enter', { timeout: 3000 });
      return 'enter';
    } catch (e) {
      throw wrap(e, 'submit failed');
    }
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

  async close(): Promise<void> {
    if (this.browser) await this.browser.close().catch(() => undefined);
  }
}
