import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { globalScrubber } from '../src/core/scrubber.js';
import { startSites } from './helpers/sites.js';

/**
 * OPT-IN: BLINDFILL_TEST_LIVE_BW=1 with an unlocked `bw` (BW_SESSION in the environment).
 * Creates throw-away items named `blindfill-live-*` in the vault, fills them into local fake
 * sites, and deletes them permanently afterwards. Use a test vault: it writes real items.
 */
const enabled = process.env.BLINDFILL_TEST_LIVE_BW === '1' && !!process.env.BW_SESSION;
const BIN = process.env.BLINDFILL_BW_BIN ?? 'bw';
const tag = randomBytes(4).toString('hex');
const PW = `LIVE-pw-${randomBytes(12).toString('base64url')}`;
const created: string[] = [];
const outputs: string[] = [];
let sites: Awaited<ReturnType<typeof startSites>>;
let browser: Browser;
let dir: string;

const backend = () => new BwBackend({ bin: BIN, env: process.env });
const O = () => `http://good.localhost:${sites.port}`;
const bw = (...args: string[]) =>
  new Promise<string>((res, rej) =>
    execFile(BIN, [...args, '--nointeraction'], { env: process.env }, (e, out) => (e ? rej(e) : res(out))),
  );
async function engine() {
  const page = await (await browser.newContext()).newPage();
  return new Engine(backend(), WebActuator.fromPage(page));
}

describe.skipIf(!enabled)('bw against a live vault (opt-in)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bf-live-'));
    process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
    sites = await startSites();
    browser = await chromium.launch({ headless: true });
    globalScrubber.register(PW);
  });
  afterAll(async () => {
    for (const id of created) await bw('delete', 'item', id, '--permanent').catch(() => undefined);
    await browser?.close();
    await sites?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create, show, totp, fill and submit once; nothing returns the password', async () => {
    const b = backend();
    const ref = await b.createItem!({
      name: `blindfill-live-${tag}`,
      username: `live-${tag}@example.test`, // the fake form's email field validates the format
      uris: [O()],
      password: PW,
      totpSeed: 'JBSWY3DPEHPK3PXP',
      fields: {},
    });
    created.push(ref.id);
    await bw('sync');
    const eng = await engine();
    const shown = await eng.itemShow({ item: ref.id });
    outputs.push(JSON.stringify(shown));
    expect(shown).toMatchObject({ username: `live-${tag}@example.test` });
    expect((await eng.totpCode({ item: ref.id })).code).toMatch(/^\d{6}$/);
    sites.received.length = 0;
    // the fake site rejects anything but its canary, so the outcome is a failure page; what matters is the POST
    const r = await eng.fill({ item: ref.id, url: `${O()}/simple`, submit: true });
    outputs.push(JSON.stringify(r));
    expect(r).toMatchObject({ locked: true, submitted: true });
    await vi.waitFor(() => expect(sites.received).toHaveLength(1), { timeout: 5000 });
    expect(sites.received[0].fields.password).toBe(PW);
    for (const o of outputs) expect(o).not.toContain(PW);
  }, 120_000);

  it('item generate then register: the generated password reaches the form only', async () => {
    const eng0 = new Engine(backend());
    const g = await eng0.itemGenerate({
      name: `blindfill-live-gen-${tag}`,
      origins: [O()],
      username: `gen-${tag}`,
    });
    created.push(g.id as string);
    outputs.push(JSON.stringify(g));
    const rule = {
      id: 'signup',
      mode: 'registration',
      top_origin: O(),
      form: '#signup',
      fields: { username: '#login', password: '#pw1' },
      confirm_password: '#pw2',
      submit: { selector: '#create', kind: 'native' },
    };
    // the vault owner adds the rule (not an agent path)
    await backend().updateItem!(
      { backend: 'bw', id: g.id as string },
      { fields: { 'blindfill.rules': JSON.stringify({ version: 2, rules: [rule] }) } },
    );
    await bw('sync');
    const generated = (await bw('get', 'password', g.id as string)).trim(); // test-only read of a throw-away item
    const eng = await engine();
    sites.received.length = 0;
    const r = await eng.register({
      item: g.id as string,
      url: `${O()}/register`,
      rule: 'signup',
      submit: true,
    });
    outputs.push(JSON.stringify(r));
    await vi.waitFor(() => expect(sites.received).toHaveLength(1), { timeout: 5000 });
    expect(sites.received[0].fields.password).toBe(generated);
    expect(sites.received[0].fields.confirm).toBe(generated);
    for (const o of outputs) expect(o).not.toContain(generated);
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).not.toContain(generated);
  }, 120_000);
});
