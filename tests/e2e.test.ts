import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { globalScrubber } from '../src/core/scrubber.js';
import { CANARY, CANARY_USER, startSites } from './helpers/sites.js';

const MOCK = resolve('tests/fixtures/mock-bw.mjs');
let browser: Browser;
let sites: Awaited<ReturnType<typeof startSites>>;
let dir: string;
let auditFile: string;
let page: Page;
/**
 * BLINDFILL_E2E_BROWSER=ego runs this suite through the running Ego Lite (ego-cli provider, owner's
 * Mac only). Each test opens a fresh Ego task space and closes it (BLINDFILL_EGO_KEEP=0).
 */
const EGO = process.env.BLINDFILL_E2E_BROWSER === 'ego';
const opened: WebActuator[] = [];

const item = (id: string, uris: string[], extra: any[] = []) => ({
  id,
  type: 1,
  name: `Fake ${id}`,
  login: {
    username: CANARY_USER,
    password: CANARY,
    totp: 'JBSWY3DPEHPK3PXP',
    uris: uris.map((uri) => ({ uri, match: 1 })),
  },
  fields: extra,
});

async function engine(hook?: () => Promise<unknown>): Promise<{ eng: Engine; act: WebActuator }> {
  let act: WebActuator;
  if (EGO) {
    act = await WebActuator.fromProvider('ego-cli', { endpoint: 'ego://new' });
    opened.push(act);
    page = act.page;
  } else {
    page = await (await browser.newContext()).newPage();
    act = WebActuator.fromPage(page);
  }
  /** `hook` runs after prepare, just before the secret is opened (to change the page in between). */
  class Hooked extends BwBackend {
    override async openSecret(...a: Parameters<BwBackend['openSecret']>) {
      await hook?.();
      return super.openSecret(...a);
    }
  }
  const backend = new Hooked({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
  return { eng: new Engine(backend, act), act };
}
const audits = () => (existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '');

beforeAll(async () => {
  if (EGO) process.env.BLINDFILL_EGO_KEEP = '0';
  else browser = await chromium.launch({ headless: true });
  sites = await startSites();
  dir = mkdtempSync(join(tmpdir(), 'bf-e2e-'));
  auditFile = join(dir, 'audit.jsonl');
  process.env.BLINDFILL_AUDIT_FILE = auditFile;
  const good = `http://good.localhost:${sites.port}/`;
  const cdn = `http://cdn.localhost:${sites.port}/`;
  const f = join(dir, 'items.json');
  writeFileSync(
    f,
    JSON.stringify([
      item('good', [good]),
      item('good-nosubmit', [good], [{ name: 'blindfill.submit', value: 'none', type: 0 }]),
      item('good-cdn', [good, cdn]),
      item(
        'good-cdn-rule',
        [good, cdn],
        [
          {
            name: 'blindfill.rules',
            type: 0,
            value: JSON.stringify({
              version: 2,
              rules: [
                {
                  id: 'framed',
                  top_origin: good.slice(0, -1),
                  frame: { selector: 'iframe', origin: cdn.slice(0, -1) },
                  form: 'form',
                  fields: { username: '#em', password: '#pw' },
                  submit: { selector: 'button[type=submit]', kind: 'native' },
                },
              ],
            }),
          },
        ],
      ),
      item(
        'good-rule',
        [good],
        [
          {
            name: 'blindfill.rules',
            type: 0,
            value: JSON.stringify({
              version: 2,
              rules: [
                {
                  id: 'late',
                  top_origin: good.slice(0, -1),
                  form: 'form',
                  fields: { username: '#em', password: '#pw' },
                  submit: { selector: 'button[type=submit]', kind: 'native' },
                },
              ],
            }),
          },
        ],
      ),
      item(
        'good-extra',
        [good],
        [
          { name: 'store_id', value: 'S-1', type: 0 },
          { name: 'pin', value: 'CANARY-pin-4242', type: 1 },
        ],
      ),
    ]),
  );
  process.env.BLINDFILL_MOCK_BW_ITEMS = f;
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  sites.received.length = 0;
  globalScrubber.register(CANARY);
});
afterEach(async () => {
  for (const act of opened.splice(0)) await act.close();
  // Ego runs out of process: let a submit that is still in flight land before the next test resets
  if (EGO) await new Promise((r) => setTimeout(r, 500));
});

const good = (p: string) => sites.url('good.localhost', p);

describe('web actuator e2e (local fake sites)', () => {
  it('simple login: fills, submits once, reports success evidence, locks the session', async () => {
    const { eng, act } = await engine();
    const r = await eng.fill({
      item: 'good',
      url: good('/simple'),
      submit: true,
      expect: { urlIncludes: '/home', failSelector: '#error' },
    });
    expect(r).toMatchObject({
      filled: ['username', 'password'],
      submitted: true,
      outcome: 'success',
      locked: true,
    });
    expect(sites.received).toHaveLength(1);
    expect(sites.received[0].fields).toEqual({ email: CANARY_USER, password: CANARY });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(globalScrubber.contains(CANARY_USER)).toBe(false); // a username is not a secret
    // post-fill lock
    await expect(act.pageText()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(act.html()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(act.screenshot()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(eng.probe()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(eng.candidates()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    // one-shot
    await page.goto(good('/simple'));
    await expect(eng.fill({ item: 'good', submit: true })).rejects.toMatchObject({ code: 'POLICY' });
    expect(sites.received).toHaveLength(1);
    expect(audits()).toContain('"event":"fill"');
    expect(audits()).not.toContain(CANARY);
  });

  describe('rule-less form and submit safety', () => {
    it.each(['/signup-confirm', '/new-password', '/split'])(
      '%s: refused before any secret is read',
      async (path) => {
        const { eng, act } = await engine();
        const err = await eng.fill({ item: 'good', url: good(path) }).catch((e) => e);
        expect(err).toMatchObject({ code: 'POLICY' });
        expect(String(err.message)).not.toContain(CANARY);
        expect(act.policy.locked).toBe(false);
        expect(await page.inputValue('input[type=password]')).toBe('');
        expect(sites.received).toHaveLength(0);
      },
    );

    it.each([
      ['/login-get', /GET/],
      ['/two-submits', /exactly one/],
      ['/formless', /not inside a <form>/],
      ['/inert-submit', /disabled/],
    ])('%s: submit refused before filling, plain fill still works', async (path, re) => {
      const { eng, act } = await engine();
      const err = await eng.fill({ item: 'good', url: good(path), submit: true }).catch((e) => e);
      expect(err).toMatchObject({ code: 'POLICY' });
      expect(String(err.message)).toMatch(re);
      expect(act.policy.locked).toBe(false);
      expect(await page.inputValue('input[type=password]')).toBe('');
      expect(sites.received).toHaveLength(0);
      const r = await eng.fill({ item: 'good' });
      expect(r).toMatchObject({ filled: ['username', 'password'], submitted: false });
      expect(sites.received).toHaveLength(0);
    });

    it.each(['good', 'good-rule'])(
      '%s: a submit enabled only after filling is waited for and clicked once',
      async (id) => {
        const { eng } = await engine();
        const r = await eng.fill({
          item: id,
          url: good('/late-enable'),
          submit: true,
          expect: { urlIncludes: '/home' },
        });
        expect(r).toMatchObject({ filled: ['username', 'password'], submitted: true, outcome: 'success' });
        expect(sites.received).toHaveLength(1);
        expect(sites.received[0].fields).toEqual({ email: CANARY_USER, password: CANARY });
      },
    );

    it.each(['good', 'good-rule'])(
      '%s: a submit that stays disabled is refused after filling, never clicked',
      async (id) => {
        const { eng } = await engine();
        const err = await eng.fill({ item: id, url: good('/always-disabled'), submit: true }).catch((e) => e);
        expect(err).toMatchObject({ code: 'POLICY' });
        expect(String(err.message)).toMatch(/disabled/);
        expect(String(err.message)).not.toContain(CANARY);
        expect(await page.inputValue('#em')).toBe(CANARY_USER);
        expect(sites.received).toHaveLength(0);
      },
    );
  });

  it('wrong evidence => failure reported, never retried', async () => {
    const { eng } = await engine();
    // item bound to good, but we pretend the site rejects: expect selector that never appears and failSelector that does not either
    const r = await eng.fill({
      item: 'good',
      url: good('/simple'),
      submit: true,
      expect: { selector: '#never', timeoutMs: 600 },
    });
    expect(r.outcome).toBe('unknown');
    expect(r.notes.join(' ')).toMatch(/does not retry/);
    expect(sites.received).toHaveLength(1);
  });

  it('no evidence given => unknown outcome', async () => {
    const { eng } = await engine();
    const r = await eng.fill({ item: 'good', url: good('/simple'), submit: true });
    expect(r.outcome).toBe('unknown');
  });

  it('submit policy none is honoured', async () => {
    const { eng } = await engine();
    const r = await eng.fill({ item: 'good-nosubmit', url: good('/simple'), submit: true });
    expect(r.submitted).toBe(false);
    expect(r.notes.join(' ')).toMatch(/submit=none/);
    expect(sites.received).toHaveLength(0);
  });

  it('two-step login: username page, then password page', async () => {
    const { eng } = await engine();
    const a = await eng.fill({
      item: 'good',
      url: good('/step1'),
      fields: ['username'],
      submit: true,
      expect: { urlIncludes: '/step2' },
    });
    expect(a).toMatchObject({ filled: ['username'], outcome: 'success', locked: false });
    // a username-only fill does not lock: the agent may still look at the next page structure
    const p = await eng.probe();
    expect(p.candidates.some((c) => c.guess?.role === 'password')).toBe(true);
    expect(p.items?.map((i) => i.id)).toContain('good');
    const b = await eng.fill({
      item: 'good',
      fields: ['password'],
      submit: true,
      expect: { urlIncludes: '/home' },
    });
    expect(b).toMatchObject({ filled: ['password'], outcome: 'success', locked: true });
    expect(sites.received.at(-1)?.fields.password).toBe(CANARY);
  });

  it('lookalike domain: refused before any secret is read; nothing typed', async () => {
    const { eng } = await engine();
    await expect(
      eng.fill({ item: 'good', url: sites.url('evil.localhost', '/simple'), submit: true }),
    ).rejects.toMatchObject({
      code: 'ORIGIN_MISMATCH',
    });
    expect(sites.received).toHaveLength(0);
    expect(await page.inputValue('input[type=password]')).toBe('');
    expect(audits()).toContain('"event":"refused"');
    const { eng: eng2 } = await engine();
    await expect(
      eng2.fill({ item: 'good', url: sites.url('good.localhost.evil.localhost', '/simple') }),
    ).rejects.toBeTruthy();
    expect(sites.received).toHaveLength(0);
  });

  it('frames: a rule-less fill never reaches a child frame, even a bound one; a frame rule does', async () => {
    for (const [id, path] of [
      ['good', '/framed'],
      ['good-cdn', '/framed-bound'],
    ]) {
      const { eng, act } = await engine();
      const err = await eng.fill({ item: id, url: good(path), submit: true }).catch((e) => e);
      expect(err).toMatchObject({ code: 'AMBIGUOUS' });
      // ego-cli does not see the cross-origin child frame at all, so its refusal lacks the frame hint
      if (!EGO) expect(String(err.message)).toMatch(/blindfill\.rules rule/);
      expect(act.policy.locked).toBe(false); // refused before any secret was read
    }
    expect(sites.received).toHaveLength(0);
    if (EGO) {
      // documented ego-cli limit: even a bound cross-origin frame is out of reach; refused, nothing typed
      const { eng: e2 } = await engine();
      await expect(
        e2.fill({ item: 'good-cdn-rule', url: good('/framed-bound'), submit: true }),
      ).rejects.toBeTruthy();
      expect(sites.received).toHaveLength(0);
      return;
    }
    const { eng: e2 } = await engine();
    const r = await e2.fill({ item: 'good-cdn-rule', url: good('/framed-bound'), submit: true });
    expect(r.filled).toEqual(['username', 'password']);
    await expect.poll(() => sites.received.length).toBe(1);
    expect(sites.received[0]).toMatchObject({ host: 'cdn.localhost' });
    expect(sites.received[0].fields.password).toBe(CANARY);
  });

  describe('document identity: bound at prepare, never rebound', () => {
    it('same-origin navigation between prepare and the secret write: refused, nothing typed', async () => {
      const { eng } = await engine(() => page.goto(good('/simple')));
      const err = await eng
        .fill({ item: 'good', url: good('/simple'), fields: ['password'] })
        .catch((e) => e);
      expect(err).toMatchObject({ code: 'ACTUATOR' });
      expect(String(err.message)).toMatch(/navigated/);
      expect(String(err.message)).not.toContain(CANARY);
      expect(await page.inputValue('input[type=password]')).toBe('');
      expect(sites.received).toHaveLength(0);
    });

    // ego-cli cannot reach a cross-origin rule frame (documented limit; covered by the frames test above)
    it.skipIf(EGO)(
      'rule frame replaced (same origin, same form) between prepare and the write: refused',
      async () => {
        const { eng } = await engine(async () => {
          const loaded = page.waitForEvent('framenavigated', (f) => f.url().includes('cdn.localhost'));
          await page.evaluate(() => {
            const f = document.querySelector('iframe') as HTMLIFrameElement;
            f.replaceWith(f.cloneNode());
          });
          await (await loaded).waitForSelector('#pw');
        });
        const err = await eng
          .fill({ item: 'good-cdn-rule', url: good('/framed-bound'), fields: ['password'] })
          .catch((e) => e);
        expect(err).toMatchObject({ code: 'ACTUATOR' });
        expect(String(err.message)).toMatch(/frame was replaced/);
        const frame = page.frames().find((f) => f.url().includes('cdn.localhost'))!;
        expect(await frame.inputValue('#pw')).toBe('');
      },
    );
  });

  it('honeypot / hidden fields are never filled', async () => {
    const { eng } = await engine();
    const r = await eng.fill({
      item: 'good',
      url: good('/honeypot'),
      submit: true,
      expect: { urlIncludes: '/home' },
    });
    expect(r.outcome).toBe('success');
    const f = sites.received[0].fields;
    expect(f.username).toBe('');
    expect(f.website_email).toBe('');
    expect(f.login_password).toBe('');
    expect(f.email).toBe(CANARY_USER);
    expect(f.password).toBe(CANARY);
  });

  it('only a hidden password field => stops, lists no secret, types nothing', async () => {
    const { eng, act } = await engine();
    await expect(
      eng.fill({ item: 'good', fields: ['password'], url: good('/onlyhidden') }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    expect(act.policy.locked).toBe(false);
    expect(sites.received).toHaveLength(0);
  });

  it('ambiguous forms: stops rather than guessing', async () => {
    const { eng } = await engine();
    await expect(
      eng.fill({ item: 'good', fields: ['password'], url: good('/ambiguous') }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS' });
  });

  it('SPA: form appears late and is re-rendered; fill still lands', async () => {
    const { eng } = await engine();
    const r = await eng.fill({
      item: 'good',
      url: good('/spa'),
      submit: true,
      expect: { urlIncludes: '/home' },
    });
    expect(r.outcome).toBe('success');
    expect(sites.received[0].fields.password).toBe(CANARY);
  });

  it('real key-event fallback when fill() leaves the field empty', async () => {
    const { eng } = await engine();
    const r = await eng.fill({
      item: 'good',
      url: good('/keys'),
      submit: true,
      expect: { urlIncludes: '/home' },
    });
    expect(r.outcome).toBe('success');
    expect(sites.received[0].fields).toEqual({ email: CANARY_USER, password: CANARY });
  });

  it('keys fallback is really the path taken on the trusted-input-only page', async () => {
    const { act } = await engine();
    await act.navigate(good('/keys'));
    const any = () => true;
    await act.bindDocument([]);
    const r = await act.fillInto(() => act.locate({ role: 'password' }), 'x-not-a-real-secret', any);
    expect(r.method).toBe('keys');
    await page.goto(good('/simple'));
    await act.bindDocument([]);
    const r2 = await act.fillInto(() => act.locate({ role: 'password' }), 'x-not-a-real-secret', any);
    expect(r2.method).toBe('fill');
  });

  it('unknown / secret custom fields: readable fill by name works, nonexistent is refused', async () => {
    const { eng } = await engine();
    await expect(eng.fill({ item: 'good', url: good('/simple'), fields: ['nope'] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const show = await eng.itemShow({ item: 'good-extra' });
    expect(show.readable).toEqual({ store_id: 'S-1' });
    expect(show.secretFields).toEqual(['password', 'pin']);
    expect(JSON.stringify(show)).not.toContain('CANARY');
  });

  it('totp: code is returned (ephemeral), seed never', async () => {
    const { eng } = await engine();
    const t = await eng.totpCode({ item: 'good' });
    expect(t.code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(t)).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('item with no binding to the page is refused even with matching username', async () => {
    const { eng } = await engine();
    await page.goto(sites.url('cdn.localhost', '/simple'));
    await expect(eng.fill({ item: 'good' })).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
  });

  it('regression: probe/candidates honour a url argument on a blank page; non-http urls refused', async () => {
    const { eng } = await engine(); // blank page
    await expect(eng.probe()).rejects.toThrow(/not an http\(s\) page/);
    const p = await eng.probe(good('/simple'));
    expect(p.origin).toBe(`http://good.localhost:${sites.port}`);
    expect(p.candidates.some((c) => c.guess?.role === 'password')).toBe(true);
    const c = await eng.candidates('password', good('/simple'));
    expect(c.candidates.length).toBeGreaterThan(0);
    await expect(eng.probe('file:///etc/passwd')).rejects.toMatchObject({ code: 'POLICY' });
    await expect(eng.probe('javascript:alert(1)')).rejects.toMatchObject({ code: 'POLICY' });
  });

  it('non-http pages are refused', async () => {
    const { eng } = await engine();
    await page.goto('about:blank');
    await expect(eng.fill({ item: 'good' })).rejects.toMatchObject({ code: 'ACTUATOR' });
  });
});
