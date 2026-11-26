import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

async function engine(): Promise<{ eng: Engine; act: WebActuator }> {
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  const act = WebActuator.fromPage(page);
  const backend = new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
  return { eng: new Engine(backend, act), act };
}
const audits = () => (existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : '');

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
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
    expect(sites.received[0].fields.password).toBe(CANARY);
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

  it('cross-origin iframe: refused unless the item binds the frame origin', async () => {
    const { eng, act } = await engine();
    await expect(eng.fill({ item: 'good', url: good('/framed'), submit: true })).rejects.toMatchObject({
      code: 'ORIGIN_MISMATCH',
    });
    expect(sites.received).toHaveLength(0);
    expect(act.policy.locked).toBe(false); // refused before any secret was read
    const { eng: e2 } = await engine();
    const r = await e2.fill({ item: 'good-cdn', url: good('/framed-bound'), submit: true });
    expect(r.filled).toEqual(['username', 'password']);
    await expect.poll(() => sites.received.length).toBe(1);
    expect(sites.received[0]).toMatchObject({ host: 'cdn.localhost' });
    expect(sites.received[0].fields.password).toBe(CANARY);
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
    const r = await act.fillInto(() => act.locate({ role: 'password' }, any), 'x-not-a-real-secret', any);
    expect(r.method).toBe('keys');
    await page.goto(good('/simple'));
    const r2 = await act.fillInto(() => act.locate({ role: 'password' }, any), 'x-not-a-real-secret', any);
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

  it('non-http pages are refused', async () => {
    const { eng } = await engine();
    await page.goto('about:blank');
    await expect(eng.fill({ item: 'good' })).rejects.toMatchObject({ code: 'ACTUATOR' });
  });
});
