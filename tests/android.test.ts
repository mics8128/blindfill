import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AndroidActuator } from '../src/actuators/android/index.js';
import { apkSigners } from '../src/actuators/android/apk.js';
import { BwBackend } from '../src/backends/bw.js';
import { Engine } from '../src/engine.js';

/**
 * Host side of the Android companion, without a device: a fake adb records the arm broadcast and
 * the test plays the phone on the loopback port. The device run is tests/android-device.test.ts.
 */
const MOCK = resolve('tests/fixtures/mock-bw.mjs');
const ADB = resolve('tests/fixtures/fake-adb.mjs');
const PW = `ANDROID-pw-${randomBytes(9).toString('base64url')}`;
const PKG = 'com.example.app';
const SIGNER = createHash('sha256').update('fake cert').digest('hex').toUpperCase();
const RP = 'example.com';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
let dir: string;
let log: string;
let goodApk: string;

const u32 = (n: number) => Buffer.from(new Uint32Array([n]).buffer);
const u64 = (n: number) => Buffer.from(new BigUint64Array([BigInt(n)]).buffer);
const lp = (...parts: Buffer[]) => {
  const c = Buffer.concat(parts);
  return Buffer.concat([u32(c.length), c]);
};
/** Minimal APK: entries | APK Signing Block (one signer per scheme) | central directory | EOCD. */
function fakeApk(...signers: [scheme: number, cert: Buffer][]): Buffer {
  const pairs = signers.map(([scheme, cert]) => {
    const signedData = Buffer.concat([lp(), lp(lp(cert)), lp()]); // digests, certificates, attributes
    const value = lp(lp(lp(signedData), lp(), lp(Buffer.alloc(8)))); // signers: [signed data, signatures, key]
    return Buffer.concat([u64(4 + value.length), u32(scheme), value]);
  });
  const size = pairs.reduce((n, p) => n + p.length, 0) + 24;
  const block = Buffer.concat([u64(size), ...pairs, u64(size), Buffer.from('APK Sig Block 42')]);
  const entries = Buffer.from('PK\x03\x04 entries');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(entries.length + block.length, 16);
  return Buffer.concat([entries, block, eocd]);
}
const V2 = 0x7109871a;
const V3 = 0xf05368c0;
const CERT = Buffer.from('companion cert');
const COMPANION_SHA = createHash('sha256').update(CERT).digest('hex').toUpperCase();
function writeApk(name: string, apk: Buffer): string {
  const f = join(dir, `${name}.apk`);
  writeFileSync(f, apk);
  return f;
}

const item = (id: string, extra: Record<string, unknown> = {}, signers = SIGNER) => ({
  id,
  type: 1,
  name: `App ${id}`,
  login: {
    username: 'app-user',
    password: PW,
    uris: [{ uri: `androidapp://${PKG}`, match: null }],
    fido2Credentials: [
      { credentialId: randomUUID(), rpId: RP, keyValue: KEY, userHandle: 'dXNlcg', counter: '0' },
    ],
    ...extra,
  },
  fields: signers ? [{ name: 'blindfill.signers', value: signers, type: 0 }] : [],
});

const engine = () =>
  new Engine(new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } }));
const android = () => new AndroidActuator(ADB);

/** Wait for the arm broadcast, then send one request as the phone would; returns the host's reply. */
async function phone(req: Record<string, unknown>, tokenOverride?: string): Promise<Record<string, unknown>> {
  let arm: string[] | undefined;
  for (let i = 0; i < 100 && !arm; i++) {
    await new Promise((r) => setTimeout(r, 20));
    arm = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
          .find((a) => a.includes('broadcast') && a[a.indexOf('token') + 1] !== '""')
      : undefined;
  }
  if (!arm) throw new Error('no arm broadcast');
  const token = tokenOverride ?? arm[arm.indexOf('token') + 1];
  const port = Number(arm[arm.indexOf('port') + 1]);
  return new Promise((res, rej) => {
    const s = connect(port, '127.0.0.1', () => s.write(JSON.stringify({ ...req, token }) + '\n'));
    let b = '';
    s.on('data', (d) => (b += d));
    s.on('end', () => res(JSON.parse(b)));
    s.on('error', rej);
  });
}

beforeAll(() => {
  chmodSync(ADB, 0o755);
  dir = mkdtempSync(join(tmpdir(), 'bf-android-'));
  process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
  process.env.BLINDFILL_COMPANION_SIGNER = COMPANION_SHA;
  goodApk = writeApk('good', fakeApk([V2, CERT], [V3, CERT]));
  const f = join(dir, 'items.json');
  writeFileSync(f, JSON.stringify([item('app'), item('nopin', {}, '')]));
  process.env.BLINDFILL_MOCK_BW_ITEMS = f;
});
beforeEach(() => {
  log = join(dir, `adb-${randomBytes(4).toString('hex')}.log`);
  process.env.FAKE_ADB_LOG = log;
  process.env.FAKE_ADB_APK = goodApk;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BLINDFILL_COMPANION_SIGNER;
  delete process.env.FAKE_ADB_APK;
});

const base = { pkg: PKG, signer: SIGNER, web: false };

describe('android companion, host side', () => {
  it('password: answers the bound app once; the value goes to the phone only', async () => {
    const run = engine().androidOffer({ item: 'app', serial: 'S1', kind: 'password' }, android());
    const reply = await phone({ ...base, kind: 'password', passwords: 1 });
    expect(reply).toEqual({ ok: true, username: 'app-user', password: PW });
    const r = await run;
    expect(r).toMatchObject({ status: 'offered', target: `android:${PKG}#sha256=${SIGNER}` });
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(readFileSync(log, 'utf8')).not.toContain(PW);
    expect(readFileSync(process.env.BLINDFILL_AUDIT_FILE!, 'utf8')).not.toContain(PW);
    // reverse port removed and phone disarmed afterwards
    expect(readFileSync(log, 'utf8')).toContain('--remove');
  });

  it.each([
    ['other signer', { signer: 'AB'.repeat(32) }],
    ['other package', { pkg: 'com.evil.app' }],
    ['no single signer', { signer: null }],
    ['web view', { web: true }],
    ['sign-up screen', { passwords: 2 }],
    ['new-password field', { newPassword: true }],
  ])('refuses %s without sending anything', async (_n, patch) => {
    const run = engine().androidOffer({ item: 'app', serial: 'S1', kind: 'password' }, android());
    const guarded = run.catch((e) => e);
    const reply = await phone({ ...base, kind: 'password', passwords: 1, ...patch });
    expect(reply).toEqual({ ok: false });
    expect(await guarded).toMatchObject({ code: 'ORIGIN_MISMATCH' });
  });

  it('a wrong token ends the arm without an answer', async () => {
    const run = engine().androidOffer({ item: 'app', serial: 'S1', kind: 'password' }, android());
    expect(await phone({ ...base, kind: 'password', passwords: 1 }, 'x'.repeat(43))).toEqual({ ok: false });
    expect(await run).toMatchObject({ status: 'refused', reason: 'bad token' });
  });

  it('expires when the phone never asks', async () => {
    const r = await engine().androidOffer(
      { item: 'app', serial: 'S1', kind: 'password', timeoutMs: 200 },
      android(),
    );
    expect(r).toMatchObject({ status: 'expired' });
  });

  it('refuses an item without a signer pin before touching the device', async () => {
    await expect(
      engine().androidOffer({ item: 'nopin', serial: 'S1', kind: 'password' }, android()),
    ).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
    expect(existsSync(log)).toBe(false);
  });

  it('passkey: the host signs; the phone gets a verifiable assertion, never the key', async () => {
    const cdh = createHash('sha256').update('{"type":"webauthn.get"}').digest();
    const run = engine().androidOffer({ item: 'app', serial: 'S1', kind: 'passkey' }, android());
    const reply = await phone({
      ...base,
      kind: 'passkey',
      rpId: RP,
      clientDataHash: cdh.toString('base64url'),
    });
    expect(reply.ok).toBe(true);
    const authData = Buffer.from(String(reply.authenticatorData), 'base64url');
    expect(authData.subarray(0, 32)).toEqual(createHash('sha256').update(RP).digest());
    const pub = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
    expect(
      verify(
        'sha256',
        Buffer.concat([authData, cdh]),
        pub,
        Buffer.from(String(reply.signature), 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.stringify(reply)).not.toContain(KEY.slice(10, 40));
    expect(await run).toMatchObject({ status: 'signed' });
  });

  it('passkey: refuses another rpId', async () => {
    const run = engine().androidOffer({ item: 'app', serial: 'S1', kind: 'passkey' }, android());
    const guarded = run.catch((e) => e);
    const reply = await phone({
      ...base,
      kind: 'passkey',
      rpId: 'evil.com',
      clientDataHash: Buffer.alloc(32).toString('base64url'),
    });
    expect(reply).toEqual({ ok: false });
    expect(await guarded).toMatchObject({ code: 'ORIGIN_MISMATCH' });
  });

  it.each([
    ['signed by another key', () => writeApk('impostor', fakeApk([V2, Buffer.from('impostor cert')]))],
    ['with a second signer', () => writeApk('two', fakeApk([V2, CERT], [V3, Buffer.from('other')]))],
    ['unsigned', () => writeApk('unsigned', Buffer.from('PK\x03\x04 not signed'))],
    ['not installed', () => undefined],
  ])('refuses a companion %s before arming it', async (_n, apk) => {
    const f = apk();
    if (f) process.env.FAKE_ADB_APK = f;
    else delete process.env.FAKE_ADB_APK;
    const r = await engine().androidOffer({ item: 'app', serial: 'S1', kind: 'password' }, android());
    expect(r).toMatchObject({ status: 'refused' });
    expect(String(r.reason)).toMatch(/companion/);
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toContain('broadcast');
    expect(calls).not.toContain(PW);
    expect(readFileSync(process.env.BLINDFILL_AUDIT_FILE!, 'utf8')).toContain(String(r.reason));
  });

  it('a reinstalled impostor is caught even after the real companion was verified', async () => {
    const ok = engine().androidOffer(
      { item: 'app', serial: 'S1', kind: 'password', timeoutMs: 200 },
      android(),
    );
    expect(await ok).toMatchObject({ status: 'expired' });
    process.env.FAKE_ADB_APK = writeApk('later-impostor', fakeApk([V2, Buffer.from('impostor')]));
    const r = await engine().androidOffer({ item: 'app', serial: 'S1', kind: 'password' }, android());
    expect(r).toMatchObject({ status: 'refused' });
  });

  it('apkSigners reads every scheme and rejects files without a signing block', () => {
    expect(apkSigners(fakeApk([V2, CERT], [V3, CERT]))).toEqual([COMPANION_SHA]);
    expect(apkSigners(fakeApk([V2, CERT], [V3, Buffer.from('x')]))).toHaveLength(2);
    expect(() => apkSigners(Buffer.from('PK\x03\x04 not signed'))).toThrow(/not a signed APK/);
    expect(() => apkSigners(Buffer.alloc(30))).toThrow(/not a signed APK/);
  });
});
