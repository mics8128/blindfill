import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BlindfillError } from '../../core/types.js';
import { apkSigners } from './apk.js';

/** Companion APK (android/companion). The arm receiver only accepts broadcasts from holders of DUMP (adb shell). */
export const COMPANION = 'io.github.mics8128.blindfill';
/** SHA-256 of the release signing certificate of the companion (public; key custody in SECURITY.md). */
export const COMPANION_SIGNER = 'C7EDE55AB64522DC9BC142F8F20B9BAABE5341D828210183D991157FE0EC45C8';
/** Secure settings `android install --set-services` switches to the companion. */
export const COMPANION_SERVICES = {
  autofill_service: `${COMPANION}/.FillService`,
  credential_service: `${COMPANION}/.PasskeyProvider`,
  credential_service_primary: `${COMPANION}/.PasskeyProvider`,
} as const;

/** Signer the host requires; BLINDFILL_COMPANION_SIGNER overrides it for development (debug key). */
const expectedSigner = () => (process.env.BLINDFILL_COMPANION_SIGNER ?? COMPANION_SIGNER).toUpperCase();
/** Installs already checked: serial|apk path|lastUpdateTime|signer. */
const verified = new Set<string>();

/** The APK shipped in the npm package (dist/android), or BLINDFILL_COMPANION_APK. */
export function companionApk(): string {
  const p =
    process.env.BLINDFILL_COMPANION_APK ??
    fileURLToPath(new URL('android/blindfill-companion.apk', import.meta.url));
  if (!existsSync(p))
    throw new BlindfillError(
      'ACTUATOR',
      `no companion APK at ${p}: published packages ship it; in a source checkout build it ` +
        '(android/README.md) and set BLINDFILL_COMPANION_APK',
    );
  return p;
}

/** What the companion reports. pkg and signer come from the system (AssistStructure / CallingAppInfo / PackageManager). */
export interface PhoneRequest {
  kind: 'password' | 'passkey';
  pkg: string;
  /** SHA-256 of the app's single signing certificate, hex; null when it has several */
  signer: string | null;
  /** the screen is a WebView or browser page (web logins go through the web actuator) */
  web: boolean;
  passwords?: number;
  newPassword?: boolean;
  rpId?: string;
  clientDataHash?: string;
}

export interface ArmOptions {
  serial: string;
  mode: 'password' | 'passkey';
  /** display labels for the phone's suggestion; not secret */
  item: string;
  user?: string;
  rpId?: string;
  timeoutMs?: number;
}

export type ServeResult =
  | { status: 'answered'; request: PhoneRequest }
  | { status: 'expired' }
  | { status: 'refused'; reason: string; request?: PhoneRequest };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/**
 * Android actuator (companion APK, ARCHITECTURE 3.2). The host never pushes a secret: it arms the
 * companion with a one-time token, listens on a loopback port the phone reaches through
 * `adb reverse`, and answers exactly one request. `answer` sees the system-attested app identity
 * and decides; whatever it returns goes to the phone and nowhere else.
 */
export class AndroidActuator {
  readonly kind = 'android' as const;

  constructor(private adbBin = process.env.BLINDFILL_ADB ?? 'adb') {}

  private adb(serial: string, args: string[], timeout = 20_000): Promise<string> {
    return new Promise((res, rej) =>
      execFile(this.adbBin, ['-s', serial, ...args], { timeout }, (e, out, err) =>
        e
          ? rej(
              new BlindfillError(
                'ACTUATOR',
                `adb failed: ${String(err || e.message)
                  .trim()
                  .slice(0, 200)}`,
              ),
            )
          : res(out),
      ),
    );
  }

  /** Serial must name exactly one attached device (never "the only one"). */
  async assertDevice(serial: string): Promise<void> {
    if (!/^[\w.:-]+$/.test(serial)) throw new BlindfillError('ACTUATOR', 'invalid device serial');
    const state = (await this.adb(serial, ['get-state'])).trim();
    if (state !== 'device') throw new BlindfillError('ACTUATOR', `device is ${state}`);
  }

  /**
   * Refusal reason, or null when the installed companion is signed by the expected certificate.
   * Reads the APK PackageManager installed (`pm path` + `exec-out cat`) and parses its APK Signing
   * Block on the host: nothing the companion says about itself is trusted. Cached per install
   * (path + lastUpdateTime change on every install or update).
   */
  async checkCompanion(serial: string): Promise<string | null> {
    const want = expectedSigner();
    const path = (await this.adb(serial, ['shell', 'pm', 'path', COMPANION]).catch(() => ''))
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .find((l) => l.endsWith('/base.apk'));
    if (!path) return 'the blindfill companion is not installed (blindfill android install)';
    if (!/^\/[\w/.~=+-]+$/.test(path)) return 'unexpected companion APK path';
    const updated = (await this.adb(serial, ['shell', 'dumpsys', 'package', COMPANION])).match(
      /lastUpdateTime=([^\n]+)/,
    )?.[1];
    const key = `${serial}|${path}|${updated}|${want}`;
    if (verified.has(key)) return null;
    const apk = await new Promise<Buffer>((res, rej) =>
      execFile(
        this.adbBin,
        ['-s', serial, 'exec-out', 'cat', path],
        { encoding: 'buffer', maxBuffer: 256 << 20, timeout: 60_000 },
        (e, out) =>
          e ? rej(new BlindfillError('ACTUATOR', 'adb failed: could not read the companion APK')) : res(out),
      ),
    );
    let signers: string[];
    try {
      signers = apkSigners(apk);
    } catch {
      return 'the installed companion APK has no readable signature';
    }
    if (signers.length !== 1 || signers[0] !== want)
      return 'the installed companion is not signed by blindfill (reinstall with blindfill android install)';
    if (updated) verified.add(key);
    return null;
  }

  /**
   * Install (or update) the packaged companion APK after checking its signer. With setServices,
   * switch autofill and credential provider to it. Returns the previous values of those settings
   * ("null" = unset) so they can be restored.
   */
  async install(
    serial: string,
    setServices: boolean,
  ): Promise<{ apk: string; previous: Record<string, string> }> {
    await this.assertDevice(serial);
    const apk = companionApk();
    const signers = apkSigners(readFileSync(apk));
    if (signers.length !== 1 || signers[0] !== expectedSigner())
      throw new BlindfillError('ACTUATOR', `${apk} is not signed by the blindfill companion key`);
    const previous: Record<string, string> = {};
    for (const k of Object.keys(COMPANION_SERVICES))
      previous[k] = (await this.adb(serial, ['shell', 'settings', 'get', 'secure', k])).trim();
    await this.adb(serial, ['install', '-r', apk], 180_000);
    if (setServices)
      for (const [k, v] of Object.entries(COMPANION_SERVICES))
        await this.adb(serial, ['shell', 'settings', 'put', 'secure', k, v]);
    return { apk, previous };
  }

  async serve(
    o: ArmOptions,
    answer: (r: PhoneRequest) => Promise<Record<string, unknown>>,
  ): Promise<ServeResult> {
    await this.assertDevice(o.serial);
    const wrongCompanion = await this.checkCompanion(o.serial);
    if (wrongCompanion) return { status: 'refused', reason: wrongCompanion };
    const token = randomBytes(32).toString('base64url');
    const server = createServer();
    await new Promise<void>((res, rej) => server.once('error', rej).listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    let failure: unknown;
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<ServeResult>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'expired' }), o.timeoutMs ?? 60_000);
      server.on('connection', (sock: Socket) => {
        server.close(); // one connection per arm, whatever it carries
        clearTimeout(timer);
        sock.setTimeout(10_000, () => sock.destroy());
        let buf = '';
        sock.on('data', async (d) => {
          buf += d.toString('utf8');
          if (buf.length > 16_384) return sock.destroy();
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          sock.pause();
          const reply = (obj: Record<string, unknown>) => sock.end(JSON.stringify(obj) + '\n');
          let req: PhoneRequest & { token?: unknown };
          try {
            req = JSON.parse(buf.slice(0, nl));
          } catch {
            reply({ ok: false });
            return resolve({ status: 'refused', reason: 'malformed request' });
          }
          const t = Buffer.from(String(req.token ?? ''));
          if (t.length !== token.length || !timingSafeEqual(t, Buffer.from(token))) {
            reply({ ok: false });
            return resolve({ status: 'refused', reason: 'bad token' });
          }
          const { token: _t, ...request } = req;
          try {
            reply({ ok: true, ...(await answer(request)) });
            resolve({ status: 'answered', request });
          } catch (e) {
            failure = e;
            reply({ ok: false });
            resolve({ status: 'refused', reason: e instanceof BlindfillError ? e.code : 'error', request });
          }
        });
      });
    });

    try {
      await this.adb(o.serial, ['reverse', `tcp:${port}`, `tcp:${port}`]);
      await this.adb(o.serial, [
        'shell',
        'am',
        'broadcast',
        '-a',
        `${COMPANION}.ARM`,
        '-n',
        `${COMPANION}/.ArmReceiver`,
        '--es',
        'token',
        token,
        '--ei',
        'port',
        String(port),
        '--es',
        'mode',
        o.mode,
        '--es',
        'item',
        b64(o.item),
        '--es',
        'user',
        b64(o.user ?? ''),
        '--es',
        'rp',
        b64(o.rpId ?? ''),
        '--el',
        'ttl',
        String(o.timeoutMs ?? 60_000),
      ]);
      const r = await done;
      if (failure) throw failure;
      return r;
    } finally {
      clearTimeout(timer);
      server.close();
      // disarm (empty token) and drop the reverse port; both best effort
      await this.adb(o.serial, [
        'shell',
        'am',
        'broadcast',
        '-a',
        `${COMPANION}.ARM`,
        '-n',
        `${COMPANION}/.ArmReceiver`,
        '--es',
        'token',
        '""',
      ]).catch(() => undefined);
      await this.adb(o.serial, ['reverse', '--remove', `tcp:${port}`]).catch(() => undefined);
    }
  }
}
