import { connect, type Socket } from 'node:net';
import { globalScrubber } from '../../core/scrubber.js';
import { BlindfillError } from '../../core/types.js';
import { assertLoopbackEndpoint } from './providers/util.js';

/** A credential as Marionette's WebAuthn:GetCredentials returns it (base64url fields). */
export interface MarionetteCredential {
  credentialId: string;
  rpId: string;
  userHandle?: string;
  signCount: number;
  privateKey: string;
}

/**
 * Minimal Marionette client (Firefox's WebDriver-classic transport: `<byte length>:<json>` frames over
 * TCP), used only for the WebAuthn:* commands Juggler lacks. Marionette has no authentication and
 * allows one session, so each ceremony opens a session, adds one authenticator, and ends both.
 */
export class Marionette {
  #sock: Socket;
  #buf = Buffer.alloc(0);
  #id = 0;
  #pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  #greeted: Promise<void>;
  #authenticatorId: string | null = null;

  private constructor(host: string, port: number) {
    this.#sock = connect({ host, port });
    let greet!: () => void;
    let fail!: (e: Error) => void;
    this.#greeted = new Promise((res, rej) => ((greet = res), (fail = rej)));
    this.#sock.on('data', (d: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, d]);
      for (;;) {
        const colon = this.#buf.indexOf(':');
        if (colon < 0) return;
        const len = Number(this.#buf.subarray(0, colon).toString());
        if (this.#buf.length < colon + 1 + len) return;
        const msg = JSON.parse(this.#buf.subarray(colon + 1, colon + 1 + len).toString('utf8')) as unknown;
        this.#buf = this.#buf.subarray(colon + 1 + len);
        if (!Array.isArray(msg)) {
          greet(); // {"applicationType":"gecko","marionetteProtocol":3}
          continue;
        }
        const [, id, err, result] = msg as [
          number,
          number,
          { error?: string; message?: string } | null,
          unknown,
        ];
        const p = this.#pending.get(id);
        this.#pending.delete(id);
        if (!p) continue;
        if (err)
          p.rej(
            new BlindfillError(
              'ACTUATOR',
              globalScrubber.scrub(`marionette: ${err.error ?? 'error'}: ${err.message ?? ''}`).slice(0, 200),
            ),
          );
        else p.res(result);
      }
    });
    const down = (e?: Error) => {
      const err = new BlindfillError('ACTUATOR', `marionette connection closed${e ? `: ${e.message}` : ''}`);
      fail(err);
      for (const p of this.#pending.values()) p.rej(err);
      this.#pending.clear();
    };
    this.#sock.on('error', down);
    this.#sock.on('close', () => down());
  }

  /** `endpoint` is host:port (loopback only), e.g. 127.0.0.1:2828. */
  static async open(endpoint: string): Promise<Marionette> {
    assertLoopbackEndpoint(`http://${endpoint}`);
    const u = new URL(`http://${endpoint}`);
    const m = new Marionette(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port || 2828));
    try {
      await m.#greeted;
      await m.cmd('WebDriver:NewSession', {});
    } catch (e) {
      m.#sock.destroy();
      throw e instanceof BlindfillError
        ? new BlindfillError(
            'ACTUATOR',
            `${e.message} (is another client holding the Marionette session at ${endpoint}?)`,
          )
        : e;
    }
    return m;
  }

  cmd(name: string, params: object): Promise<unknown> {
    const id = ++this.#id;
    const body = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej });
      this.#sock.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
    });
  }

  /** One user-verifying, resident-key CTAP2.1 authenticator; browser-wide in Firefox. */
  async addAuthenticator(): Promise<string> {
    const r = (await this.cmd('WebAuthn:AddVirtualAuthenticator', {
      protocol: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    })) as string | { value: string };
    this.#authenticatorId = typeof r === 'string' ? r : r.value;
    return this.#authenticatorId;
  }

  /** The authenticator's credentials; private keys are registered with the scrubber first. */
  async credentials(): Promise<MarionetteCredential[]> {
    const r = (await this.cmd('WebAuthn:GetCredentials', { authenticatorId: this.#authenticatorId })) as
      MarionetteCredential[] | { value: MarionetteCredential[] };
    const list = Array.isArray(r) ? r : r.value;
    for (const c of list) {
      globalScrubber.register(c.privateKey);
      globalScrubber.register(Buffer.from(c.privateKey, 'base64url').toString('base64'));
    }
    return list;
  }

  /** Remove the authenticator (and with it every credential), end the session, disconnect. */
  async close(): Promise<void> {
    if (this.#authenticatorId)
      await this.cmd('WebAuthn:RemoveVirtualAuthenticator', { authenticatorId: this.#authenticatorId }).catch(
        () => undefined,
      );
    await this.cmd('WebDriver:DeleteSession', {}).catch(() => undefined);
    this.#sock.destroy();
  }
}
