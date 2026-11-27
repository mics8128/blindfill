import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine, normalizeTotpSeed } from '../src/engine.js';
import { startSites } from './helpers/sites.js';

const MOCK = resolve('tests/fixtures/mock-bw.mjs');
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SHOWN = 'jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp'; // how setup pages usually show it
let dir: string;
let file: string;
let sites: Awaited<ReturnType<typeof startSites>>;
let browser: Browser;
const outputs: string[] = [];

const backend = () => new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
const stored = () =>
  JSON.parse(readFileSync(file, 'utf8')) as { id: string; name: string; login: { totp?: string | null } }[];
const audit = () => readFileSync(join(dir, 'audit.jsonl'), 'utf8');
const O = () => `http://good.localhost:${sites.port}`;

async function item(name: string, seed?: string): Promise<string> {
  const r = await new Engine(backend()).itemCreate({
    name,
    origins: [O()],
    username: 'u',
    password: 'pw-for-enroll-test-1!',
    totpSeed: seed,
  });
  return r.id as string;
}

async function pageWith(html: string, host = 'good.localhost'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://${host}:${sites.port}/setup`);
  await page.setContent(html);
  return page;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bf-enroll-'));
  file = join(dir, 'items.json');
  writeFileSync(file, '[]');
  process.env.BLINDFILL_MOCK_BW_ITEMS = file;
  process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
  sites = await startSites();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeTotpSeed', () => {
  it('accepts spaced/lowercase keys and otpauth URIs; refuses anything else without echoing it', () => {
    expect(normalizeTotpSeed(` ${SHOWN} `)).toBe(SEED);
    expect(normalizeTotpSeed(`otpauth://totp/Shop:a%40b?secret=${SEED.toLowerCase()}&issuer=Shop`)).toBe(
      SEED,
    );
    const custom = normalizeTotpSeed(`otpauth://totp/x?secret=${SEED}&digits=8`);
    expect(custom).toMatch(/^otpauth:\/\/totp\/x\?/);
    expect(new URL(custom).searchParams.get('digits')).toBe('8');
    for (const bad of ['hello-world-1890-not-base32', 'ABCDEFGH', `otpauth://hotp/x?secret=${SEED}`, ''])
      try {
        normalizeTotpSeed(bad);
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain(bad || '\u0000');
      }
  });
});

describe('totp enroll (bw, mock)', () => {
  it('writes the key from the page into an item without a seed; returns only the id', async () => {
    const id = await item('enroll-ok');
    const page = await pageWith(`<p>Setup key</p><code data-testid="key">${SHOWN}</code>`);
    const r = await new Engine(backend(), WebActuator.fromPage(page)).totpEnroll({
      item: id,
      selector: '[data-testid=key]',
    });
    outputs.push(JSON.stringify(r));
    expect(r).toEqual({ status: 'completed', id, totp_enrolled: true, secret_exposed: false });
    expect(stored().find((i) => i.id === id)!.login.totp).toBe(SEED);
    expect((await new Engine(backend()).totpCode({ item: id })).code).toMatch(/^\d{6}$/);
  });

  it('reads an otpauth URI from a link href', async () => {
    const id = await item('enroll-href');
    const page = await pageWith(
      `<a id="app" href="otpauth://totp/Shop:u?secret=${SEED}&issuer=Shop">open app</a>`,
    );
    await new Engine(backend(), WebActuator.fromPage(page)).totpEnroll({ item: id, selector: '#app' });
    expect(stored().find((i) => i.id === id)!.login.totp).toBe(SEED);
  });

  it('refuses: existing seed, wrong origin, several matches, no match, not base32; nothing written', async () => {
    const other = 'KRUGS4ZANFZSAYJAONSWGZLUEBVWK6IK';
    const has = await item('enroll-has', other);
    const empty = await item('enroll-empty');
    const run = async (id: string, html: string, selector: string, host?: string) => {
      const page = await pageWith(html, host);
      try {
        await new Engine(backend(), WebActuator.fromPage(page)).totpEnroll({ item: id, selector });
        return null;
      } catch (e) {
        outputs.push((e as Error).message);
        return e as { code: string; message: string };
      }
    };
    const key = `<code id="k">${SHOWN}</code>`;
    expect(await run(has, key, '#k')).toMatchObject({ code: 'POLICY' });
    expect(stored().find((i) => i.id === has)!.login.totp).toBe(other);
    expect(await run(empty, key, '#k', 'evil.localhost')).toMatchObject({ code: 'ORIGIN_MISMATCH' });
    expect(
      await run(empty, `${key}<code class="k">${SHOWN}</code><code class="k">x</code>`, '.k'),
    ).toMatchObject({
      code: 'AMBIGUOUS',
    });
    expect(await run(empty, `<iframe srcdoc='${key}'></iframe>`, '#k')).toMatchObject({ code: 'AMBIGUOUS' });
    const notKey = 'Not-A-Key-0189!';
    const e = await run(empty, `<code id="k">${notKey}</code>`, '#k');
    expect(e).toMatchObject({ code: 'POLICY' });
    expect(e!.message).not.toContain(notKey);
    expect(stored().find((i) => i.id === empty)!.login.totp).toBeFalsy();
    // the backend enforces add-only too
    await expect(backend().updateSecret({ backend: 'bw', id: has }, 'totp', SEED)).rejects.toMatchObject({
      code: 'POLICY',
    });
    // item edit cannot reach the seed
    await expect(
      new Engine(backend()).itemEdit({ item: empty }, { secrets: { totp: SEED }, human: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);

  it('CLI: the seed is in no stdout, stderr or audit line', async () => {
    const id = await item('enroll-cli');
    const port = await new Promise<number>((res) => {
      const s = createServer().listen(0, () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    const b = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    try {
      const page = await (await b.newContext()).newPage();
      await page.goto(`${O()}/setup`);
      await page.setContent(`<code data-testid="key">${SHOWN}</code>`);
      const cfg = join(dir, 'config.json');
      writeFileSync(cfg, JSON.stringify({ backend: 'bw', backends: { bw: { bin: MOCK } } }));
      const run = (args: string[]) =>
        new Promise<{ code: number; text: string }>((res) =>
          execFile(
            process.execPath,
            ['--import', 'tsx', 'src/cli.ts', ...args],
            {
              env: {
                ...process.env,
                BLINDFILL_CONFIG: cfg,
                BW_SESSION: 'mock-session-token',
                BLINDFILL_STATE_DIR: join(dir, 'state'),
              },
              cwd: resolve('.'),
            },
            (e, stdout, stderr) =>
              res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, text: stdout + stderr }),
          ),
        );
      const args = [
        'totp',
        'enroll',
        '--item',
        id,
        '--selector',
        '[data-testid=key]',
        '--cdp',
        `http://127.0.0.1:${port}`,
      ];
      const r = await run(args);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.text)).toMatchObject({ id, totp_enrolled: true });
      expect(stored().find((i) => i.id === id)!.login.totp).toBe(SEED);
      const again = await run(args);
      expect(again.code).toBe(1);
      expect(again.text).toContain('already has a TOTP seed');
      outputs.push(r.text, again.text);
    } finally {
      await b.close();
    }
    for (const o of [...outputs, audit()]) {
      expect(o).not.toContain(SEED);
      expect(o.toUpperCase().replace(/\s/g, '')).not.toContain(SEED);
    }
  }, 60_000);
});
