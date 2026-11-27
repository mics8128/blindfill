import { execFileSync } from 'node:child_process';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AndroidActuator, COMPANION, COMPANION_SIGNER } from '../src/actuators/android/index.js';
import { apkSigners } from '../src/actuators/android/apk.js';
import { BwBackend } from '../src/backends/bw.js';
import { Engine } from '../src/engine.js';

/**
 * OPT-IN, real phone or emulator: BLINDFILL_TEST_ANDROID_SERIAL=<adb serial> (e.g. emulator-5554),
 * unlocked screen, APKs built (`cd android && ./gradlew assembleDebug`). Installs the companion
 * (BLINDFILL_COMPANION_APK, e.g. the signed release APK; default the debug build) and the fake
 * relying party, switches the autofill and credential provider to blindfill for the run, then
 * restores both settings and uninstalls the two apps. Fake data only. A debug companion is
 * accepted by pinning its own signer (BLINDFILL_COMPANION_SIGNER); a release one must match
 * COMPANION_SIGNER.
 */
const SERIAL = process.env.BLINDFILL_TEST_ANDROID_SERIAL;
const ADB = process.env.BLINDFILL_ADB ?? 'adb';
const RP_PKG = `${COMPANION}.testrp`;
const RP_ID = 'blindfill-test.invalid';
const APK = (m: string) => resolve(`android/${m}/build/outputs/apk/debug/${m}-debug.apk`);
const COMPANION_APK = process.env.BLINDFILL_COMPANION_APK ?? APK('companion');
const PW = `DEV-pw-${randomBytes(9).toString('base64url')}`;
const USER = 'device-user@example.test';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const adb = (...a: string[]) =>
  execFileSync(ADB, ['-s', SERIAL!, ...a], { encoding: 'utf8', timeout: 30_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let dir: string;
const saved: Record<string, string> = {};

/** Find a node in the current UI by text or content-desc; returns its centre. */
function find(match: (attrs: string) => boolean): [number, number] | null {
  adb('shell', 'uiautomator', 'dump', '/sdcard/bf-ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/bf-ui.xml');
  for (const n of xml.match(/<node [^>]*>/g) ?? []) {
    if (!match(n)) continue;
    const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (b) return [(+b[1] + +b[3]) >> 1, (+b[2] + +b[4]) >> 1];
  }
  return null;
}
async function tap(match: (attrs: string) => boolean, what: string, tries = 15): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const p = find(match);
    if (p) {
      adb('shell', 'input', 'tap', String(p[0]), String(p[1]));
      return;
    }
    await sleep(700);
  }
  throw new Error(`not on screen: ${what}`);
}
const has = (s: string) => (n: string) => n.includes(s);
async function status(want: RegExp): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const n = find(has('content-desc="status"'));
    const xml = adb('shell', 'cat', '/sdcard/bf-ui.xml');
    const t = xml.match(/<node [^>]*content-desc="status"[^>]*>/)?.[0].match(/ text="([^"]*)"/)?.[1] ?? '';
    if (n && want.test(t)) return t;
    await sleep(700);
  }
  throw new Error('status did not change');
}
function startRp() {
  adb('shell', 'am', 'force-stop', RP_PKG);
  adb('shell', 'am', 'start', '-W', '-n', `${RP_PKG}/.MainActivity`);
}

describe.skipIf(!SERIAL)('android companion on a real device (opt-in)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bf-dev-'));
    process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
    const [signer] = apkSigners(readFileSync(APK('testrp')));
    const [companionSigner] = apkSigners(readFileSync(COMPANION_APK));
    process.env.BLINDFILL_COMPANION_APK = COMPANION_APK;
    if (companionSigner !== COMPANION_SIGNER) process.env.BLINDFILL_COMPANION_SIGNER = companionSigner;
    const items = join(dir, 'items.json');
    writeFileSync(
      items,
      JSON.stringify([
        {
          id: 'dev-app',
          type: 1,
          name: 'Test RP',
          login: {
            username: USER,
            password: PW,
            uris: [{ uri: `androidapp://${RP_PKG}`, match: null }],
            fido2Credentials: [
              {
                credentialId: randomUUID(),
                rpId: RP_ID,
                keyValue: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
                userHandle: Buffer.from('device-user').toString('base64url'),
                counter: '0',
              },
            ],
          },
          fields: [{ name: 'blindfill.signers', value: signer, type: 0 }],
        },
        {
          id: 'dev-reg',
          type: 1,
          name: 'Reg RP',
          login: {
            username: USER,
            uris: [
              { uri: `androidapp://${RP_PKG}`, match: null },
              { uri: `https://${RP_ID}`, match: null },
            ],
            fido2Credentials: [],
          },
          fields: [
            { name: 'blindfill.signers', value: signer, type: 0 },
            { name: 'blindfill.registration', value: 'allow', type: 0 },
          ],
        },
      ]),
    );
    process.env.BLINDFILL_MOCK_BW_ITEMS = items;
    // install() records the three settings before touching them, as `blindfill android install` does
    Object.assign(saved, (await new AndroidActuator(ADB).install(SERIAL!, false)).previous);
    // the installed companion passes the host's signer check (and the check is cached for the tests)
    expect(await new AndroidActuator(ADB).checkCompanion(SERIAL!)).toBeNull();
    adb('install', '-r', APK('testrp'));
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    adb('shell', 'wm', 'dismiss-keyguard');
  }, 120_000);

  afterAll(() => {
    // restore exactly: "null" = was unset, "" = was set to empty (quoted for the device shell)
    for (const [k, v] of Object.entries(saved))
      if (v === 'null') adb('shell', 'settings', 'delete', 'secure', k);
      else adb('shell', 'settings', 'put', 'secure', k, v === '' ? '""' : v);
    if (process.env.BLINDFILL_ANDROID_KEEP !== '1') {
      adb('uninstall', RP_PKG);
      adb('uninstall', COMPANION);
    }
    adb('shell', 'rm', '-f', '/sdcard/bf-ui.xml');
    rmSync(dir, { recursive: true, force: true });
    delete process.env.BLINDFILL_COMPANION_SIGNER;
    delete process.env.BLINDFILL_COMPANION_APK;
  });

  const engine = () =>
    new Engine(
      new BwBackend({
        bin: resolve('tests/fixtures/mock-bw.mjs'),
        env: { ...process.env, BW_SESSION: 'mock-session-token' },
      }),
    );

  it('password: the bound app gets a blindfill suggestion that fills both fields', async () => {
    adb('shell', 'settings', 'put', 'secure', 'autofill_service', `${COMPANION}/.FillService`);
    startRp();
    const run = engine().androidOffer(
      { item: 'dev-app', serial: SERIAL!, kind: 'password', timeoutMs: 45_000 },
      new AndroidActuator(ADB),
    );
    await sleep(1500); // arm broadcast delivered
    await tap(has('content-desc="username"'), 'username field');
    await tap(has('text="blindfill: Test RP"'), 'blindfill suggestion');
    const r = await run;
    expect(r).toMatchObject({ status: 'offered' });
    expect(JSON.stringify(r)).not.toContain(PW);
    await tap(has('text="check"'), 'check button');
    const pwHash = createHash('sha256').update(PW).digest('hex');
    expect(await status(/pwsha256=/)).toBe(`user=${USER} pwsha256=${pwHash}`);
  }, 120_000);

  it('passkey: the app gets an assertion signed on the host for its rpId', async () => {
    adb('shell', 'settings', 'put', 'secure', 'credential_service', `${COMPANION}/.PasskeyProvider`);
    adb('shell', 'settings', 'put', 'secure', 'credential_service_primary', `${COMPANION}/.PasskeyProvider`);
    startRp();
    const run = engine().androidOffer(
      { item: 'dev-app', serial: SERIAL!, kind: 'passkey', timeoutMs: 45_000 },
      new AndroidActuator(ADB),
    );
    await sleep(1500);
    await tap(has('text="passkey"'), 'passkey button');
    await tap((n) => n.includes(USER) || n.includes('blindfill: Test RP'), 'blindfill passkey entry');
    // some Android versions confirm with a second button
    const cont = find((n) => /text="(Continue|Sign in|繼續|登入)"/.test(n));
    if (cont) adb('shell', 'input', 'tap', String(cont[0]), String(cont[1]));
    expect(await run).toMatchObject({ status: 'signed' });
    expect(await status(/passkey: /)).toBe('passkey: ok');
    const resp = JSON.parse(adb('shell', 'run-as', RP_PKG, 'cat', 'files/passkey.json'));
    const challenge = adb('shell', 'run-as', RP_PKG, 'cat', 'files/challenge.txt').trim();
    const clientData = Buffer.from(resp.response.clientDataJSON, 'base64url');
    expect(JSON.parse(clientData.toString('utf8'))).toMatchObject({ type: 'webauthn.get', challenge });
    const authData = Buffer.from(resp.response.authenticatorData, 'base64url');
    expect(authData.subarray(0, 32)).toEqual(createHash('sha256').update(RP_ID).digest());
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const pub = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
    expect(verify('sha256', signed, pub, Buffer.from(resp.response.signature, 'base64url'))).toBe(true);
  }, 120_000);

  it('passkey-create: the app registers a passkey made on the host, then signs in with it', async () => {
    adb('shell', 'settings', 'put', 'secure', 'credential_service', `${COMPANION}/.PasskeyProvider`);
    adb('shell', 'settings', 'put', 'secure', 'credential_service_primary', `${COMPANION}/.PasskeyProvider`);
    startRp();
    const run = engine().androidPasskeyRegister(
      { item: 'dev-reg', serial: SERIAL!, rpId: RP_ID, timeoutMs: 45_000 },
      new AndroidActuator(ADB),
    );
    await sleep(1500);
    await tap(has('text="register"'), 'register button');
    // the create sheet names the provider ("blindfill"), not the entry; one provider entry: Continue
    await tap((n) => /text="(Continue|Create|繼續|建立)"/.test(n), 'create sheet confirm');
    expect(await run).toMatchObject({ status: 'registered', rp_id: RP_ID });
    expect(await status(/register: /)).toBe('register: ok');
    const reg = JSON.parse(adb('shell', 'run-as', RP_PKG, 'cat', 'files/registration.json'));
    const regChallenge = adb('shell', 'run-as', RP_PKG, 'cat', 'files/reg-challenge.txt').trim();
    const regClient = JSON.parse(Buffer.from(reg.response.clientDataJSON, 'base64url').toString('utf8'));
    expect(regClient).toMatchObject({ type: 'webauthn.create', challenge: regChallenge });
    const regAuth = Buffer.from(reg.response.authenticatorData, 'base64url');
    expect(regAuth.subarray(0, 32)).toEqual(createHash('sha256').update(RP_ID).digest());
    expect(regAuth[32]).toBe(0x5d);
    expect(reg.response.publicKeyAlgorithm).toBe(-7);

    startRp();
    const signIn = engine().androidOffer(
      { item: 'dev-reg', serial: SERIAL!, kind: 'passkey', timeoutMs: 45_000 },
      new AndroidActuator(ADB),
    );
    await sleep(1500);
    await tap(has('text="passkey"'), 'passkey button');
    await tap((n) => n.includes(USER) || n.includes('blindfill: Reg RP'), 'blindfill passkey entry');
    const cont = find((n) => /text="(Continue|Sign in|繼續|登入)"/.test(n));
    if (cont) adb('shell', 'input', 'tap', String(cont[0]), String(cont[1]));
    expect(await signIn).toMatchObject({ status: 'signed', sign_count: 0 });
    expect(await status(/passkey: /)).toBe('passkey: ok');
    const resp = JSON.parse(adb('shell', 'run-as', RP_PKG, 'cat', 'files/passkey.json'));
    expect(resp.id).toBe(reg.id);
    const clientData = Buffer.from(resp.response.clientDataJSON, 'base64url');
    const signed = Buffer.concat([
      Buffer.from(resp.response.authenticatorData, 'base64url'),
      createHash('sha256').update(clientData).digest(),
    ]);
    const pub = createPublicKey({
      key: Buffer.from(reg.response.publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    expect(verify('sha256', signed, pub, Buffer.from(resp.response.signature, 'base64url'))).toBe(true);
  }, 150_000);

  it('refuses before arming when the installed companion has another signer than the pin', async () => {
    const pinned = process.env.BLINDFILL_COMPANION_SIGNER;
    process.env.BLINDFILL_COMPANION_SIGNER = 'AB'.repeat(32);
    try {
      const r = await engine().androidOffer(
        { item: 'dev-app', serial: SERIAL!, kind: 'password', timeoutMs: 5_000 },
        new AndroidActuator(ADB),
      );
      expect(r).toMatchObject({ status: 'refused' });
      expect(String(r.reason)).toMatch(/not signed by blindfill/);
    } finally {
      if (pinned) process.env.BLINDFILL_COMPANION_SIGNER = pinned;
      else delete process.env.BLINDFILL_COMPANION_SIGNER;
    }
  }, 60_000);
});
