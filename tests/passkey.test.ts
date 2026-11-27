import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { startSites } from './helpers/sites.js';

/**
 * Passkey sign-in end to end: a fake relying party (tests/helpers/sites.ts /passkey) asks for an
 * assertion; blindfill answers it from the vault item's passkey through a Chromium virtual
 * authenticator. The test verifies the signature like a real RP would.
 */
const MOCK = resolve('tests/fixtures/mock-bw.mjs');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
const USER_HANDLE = randomBytes(16).toString('base64url');
let sites: Awaited<ReturnType<typeof startSites>>;
let dir: string;
let itemsFile: string;
const vaultCounter = (id: string): string =>
  (
    JSON.parse(readFileSync(itemsFile, 'utf8')) as {
      id: string;
      login: { fido2Credentials: { counter: string }[] };
    }[]
  ).find((x) => x.id === id)!.login.fido2Credentials[0].counter;
let browser: Browser;
const opened: WebActuator[] = [];
const outputs: string[] = [];

const O = () => `http://good.localhost:${sites.port}`;
const passkeyItem = (id: string, rpId: string, counter = '0') => ({
  id,
  type: 1,
  name: `Passkey ${id}`,
  login: {
    username: 'pk-user',
    uris: [{ uri: `${O()}/`, match: 1 }],
    fido2Credentials: [
      {
        credentialId: randomUUID(),
        rpId,
        keyAlgorithm: 'ECDSA',
        keyCurve: 'P-256',
        keyValue: KEY,
        userHandle: USER_HANDLE,
        counter,
        discoverable: 'true',
      },
    ],
  },
});
async function engine() {
  const act = await WebActuator.fromProvider('chromium-launch', { headless: true });
  opened.push(act);
  const backend = new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
  return new Engine(backend, act);
}

beforeAll(async () => {
  sites = await startSites();
  dir = mkdtempSync(join(tmpdir(), 'bf-pk-'));
  process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
  itemsFile = join(dir, 'items.json');
  writeFileSync(
    itemsFile,
    JSON.stringify([
      passkeyItem('pk-good', 'good.localhost'),
      passkeyItem('pk-other', 'other.localhost'),
      passkeyItem('pk-strict', 'good.localhost'),
      passkeyItem('pk-five', 'good.localhost', '5'),
    ]),
  );
  process.env.BLINDFILL_MOCK_BW_ITEMS = itemsFile;
});
afterAll(async () => {
  for (const a of opened) await a.close();
  await browser?.close();
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('passkey sign-in (Chromium virtual authenticator)', () => {
  it('answers the bound page once with a valid signature; the key is never returned', async () => {
    const eng = await engine();
    sites.received.length = 0;
    const r = await eng.passkey({
      item: 'pk-good',
      url: `${O()}/passkey`,
      click: '#pk',
      expect: { urlIncludes: '/home' },
    });
    outputs.push(JSON.stringify(r));
    expect(r).toMatchObject({ status: 'asserted', outcome: 'success', counter_written_back: true });

    const a = sites.received.find((x) => x.path === '/passkey')!.fields;
    const authData = Buffer.from(a.authenticatorData, 'base64url');
    const clientData = Buffer.from(a.clientDataJSON, 'base64url');
    const cd = JSON.parse(clientData.toString('utf8'));
    expect(cd).toMatchObject({ type: 'webauthn.get', origin: O() });
    expect(authData.subarray(0, 32)).toEqual(createHash('sha256').update('good.localhost').digest());
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const pub = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
    expect(verify('sha256', signed, pub, Buffer.from(a.signature, 'base64url'))).toBe(true);
    expect(a.userHandle).toBe(USER_HANDLE);

    // one-shot per session and origin
    await expect(eng.passkey({ item: 'pk-good', url: `${O()}/passkey`, click: '#pk' })).rejects.toThrow(
      /one-shot/,
    );
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    for (const o of [...outputs, audit]) expect(o).not.toContain(KEY.slice(8, 40));
  }, 60_000);

  it('a strict relying party accepts three sign-ins in a row; the vault counter follows (BE=BS=1)', async () => {
    for (const want of [1, 2, 3]) {
      const eng = await engine(); // fresh session each time, like separate logins
      sites.received.length = 0;
      const r = await eng.passkey({
        item: 'pk-strict',
        url: `${O()}/passkey`,
        click: '#pk',
        expect: { urlIncludes: '/home' },
      });
      const a = sites.received.find((x) => x.path === '/passkey')!.fields;
      const authData = Buffer.from(a.authenticatorData, 'base64url');
      expect({ verdict: a.verdict, count: authData.readUInt32BE(33), flags: authData[32] & 0x18 }).toEqual({
        verdict: 'accepted',
        count: want,
        flags: 0x18,
      });
      expect(r).toMatchObject({
        status: 'asserted',
        outcome: 'success',
        sign_count: want,
        counter_written_back: true,
      });
      expect(vaultCounter('pk-strict')).toBe(String(want));
    }
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).not.toContain(KEY.slice(8, 40));
  }, 90_000);

  it('continues from a stored counter (5 -> 6)', async () => {
    const r = await (await engine()).passkey({ item: 'pk-five', url: `${O()}/passkey`, click: '#pk' });
    expect(r).toMatchObject({ status: 'asserted', sign_count: 6, counter_written_back: true });
    expect(vaultCounter('pk-five')).toBe('6');
  }, 60_000);

  it('refuses before reading the key: lookalike origin, rpId that does not cover the host, no CDP', async () => {
    const eng = await engine();
    sites.received.length = 0;
    await expect(
      eng.passkey({ item: 'pk-good', url: `http://evil.localhost:${sites.port}/passkey`, click: '#pk' }),
    ).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
    await expect(
      eng.passkey({ item: 'pk-other', url: `${O()}/passkey`, click: '#pk' }),
    ).rejects.toMatchObject({
      code: 'ORIGIN_MISMATCH',
    });
    expect(sites.received).toHaveLength(0);

    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    const plain = new Engine(
      new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } }),
      WebActuator.fromPage(page), // a borrowed page has no CDP capability
    );
    await expect(
      plain.passkey({ item: 'pk-good', url: `${O()}/passkey`, click: '#pk' }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  }, 60_000);

  it('item show lists the passkey by name and rpId only', async () => {
    const eng = new Engine(
      new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } }),
    );
    const s = JSON.stringify(await eng.itemShow({ item: 'pk-good' }));
    expect(s).toContain('"passkey"');
    expect(s).toContain('good.localhost');
    expect(s).not.toContain(KEY.slice(8, 40));
  });

  it('never types the private key into a field', async () => {
    const eng = await engine();
    sites.received.length = 0;
    await expect(
      eng.fill({ item: 'pk-good', url: `${O()}/simple`, fields: ['passkey'] }),
    ).rejects.toMatchObject({ code: 'SECRET_ACCESS' });
    expect(sites.received).toHaveLength(0);
  });
});
