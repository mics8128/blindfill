import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { SessionPolicy } from '../src/core/policy.js';
import { CANARY, CANARY_USER, startSites } from './helpers/sites.js';

let browser: Browser;
let sites: Awaited<ReturnType<typeof startSites>>;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  sites = await startSites();
  dir = mkdtempSync(join(tmpdir(), 'bf-handoff-'));
  process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
  const uri = `http://good.localhost:${sites.port}/`;
  writeFileSync(
    join(dir, 'items.json'),
    JSON.stringify([
      {
        id: 'h1',
        type: 1,
        name: 'H',
        login: { username: CANARY_USER, password: CANARY, uris: [{ uri, match: 1 }] },
        fields: [],
      },
    ]),
  );
  process.env.BLINDFILL_MOCK_BW_ITEMS = join(dir, 'items.json');
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});

const mk = async (persisted: { n: number } = { n: 0 }) => {
  const page = await (await browser.newContext()).newPage();
  const policy = new SessionPolicy();
  const act = WebActuator.fromPage(page, policy);
  const backend = new BwBackend({
    bin: resolve('tests/fixtures/mock-bw.mjs'),
    env: { ...process.env, BW_SESSION: 'mock-session-token' },
  });
  return { eng: new Engine(backend, act, () => void persisted.n++), policy, page, persisted };
};

describe('human handoff', () => {
  it('pause refuses every agent-driven action; pages stay origin+path only; resume restores', async () => {
    const { eng, page, policy, persisted } = await mk();
    await page.goto(`http://good.localhost:${sites.port}/simple?token=QS-SECRET`);
    const p = eng.handoffPause('captcha');
    expect(p).toMatchObject({ status: 'paused', reason: 'captcha', secrets_exposed: false });
    expect(JSON.stringify(p)).not.toContain('QS-SECRET');
    expect(persisted.n).toBeGreaterThan(0);
    const call = [
      () => eng.fill({ item: 'h1', submit: true }),
      () => eng.probe(),
      () => eng.candidates(),
      () => eng.discover({ item: 'h1' }),
      () => eng.diagnose({ item: 'h1' }),
      () => eng.verify({ success: '#x' }),
      () => eng.fillTotp({ item: 'h1' }),
      () => eng.register({ item: 'h1', rule: 'r' }),
    ];
    for (const c of call) await expect(c()).rejects.toThrow(/paused for a human/);
    expect(() => eng.handoffPause('captcha')).toThrow(/already paused/);
    expect((eng.pages() as { pages: unknown[] }).pages).toHaveLength(1);
    expect(sites.received).toHaveLength(0);
    // the human types something; blindfill neither sees nor stores it
    await page.fill('#em', 'typed-by-human');
    const r = eng.handoffResume();
    expect(r).toMatchObject({ status: 'active', locked: false });
    expect(policy.paused).toBeNull();
    expect(() => eng.handoffResume()).toThrow(/not paused/);
    expect((await eng.probe()).origin).toContain('good.localhost');
  });

  it('resume never clears the post-fill lock or one-shot counters; bindings are rechecked afterwards', async () => {
    const { eng, page, policy } = await mk();
    await page.goto(`http://good.localhost:${sites.port}/simple`);
    await eng.fill({ item: 'h1' });
    expect(policy.locked).toBe(true);
    eng.handoffPause('mfa');
    eng.handoffResume();
    expect(policy.locked).toBe(true);
    await expect(eng.probe()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(eng.fill({ item: 'h1' })).rejects.toThrow(/one-shot/);
    // the human navigated elsewhere: the next fill is refused by binding, not by pause state
    const b = await mk();
    await b.page.goto(`http://good.localhost:${sites.port}/simple`);
    b.eng.handoffPause('consent');
    await b.page.goto(`http://evil.localhost:${sites.port}/simple`);
    b.eng.handoffResume();
    await expect(b.eng.fill({ item: 'h1', submit: true })).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
    expect(sites.received).toHaveLength(0);
  });

  it('only fixed reasons are accepted (no free text channel)', async () => {
    const { eng } = await mk();
    expect(() => eng.handoffPause('please send password hunter2')).toThrow(/reason must be one of/);
  });
});
