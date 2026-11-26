import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery } from './spi.js';
import { execRunner, parseJson, safeErr, type Runner } from './runner.js';
import { RawItemBackend } from './rawitem.js';
import { type BwRawItem } from './bwmap.js';

export { mapBwItem, type BwRawItem } from './bwmap.js';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface BwOptions {
  bin?: string;
  runner?: Runner;
  /** override env var source (tests) */
  env?: NodeJS.ProcessEnv;
}

export class BwBackend extends RawItemBackend {
  readonly id = 'bw';
  readonly tier = 'verified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'TOTP', 'ANDROID_APPS', 'CUSTOM_FIELDS']);
  #bin: string;
  #run: Runner;
  #env: NodeJS.ProcessEnv;

  constructor(opts: BwOptions = {}) {
    super();
    this.#env = opts.env ?? process.env;
    this.#bin = opts.bin ?? this.#env.BLINDFILL_BW_BIN ?? 'bw';
    this.#run = opts.runner ?? execRunner;
  }

  async #bw(args: string[]): Promise<string> {
    const session = this.#env.BW_SESSION;
    if (!session)
      throw new BlindfillError('LOCKED', 'BW_SESSION is not set (vault locked); unlock it outside blindfill');
    // session goes by environment, never on the command line (visible in ps)
    const r = await this.#run(this.#bin, [...args, '--nointeraction'], {
      env: { BW_SESSION: session, BW_NOINTERACTION: 'true' },
    });
    if (r.code !== 0) {
      const msg = safeErr(r.stderr || r.stdout, [session]);
      if (/locked|not logged in|session key is invalid|invalid master password/i.test(msg))
        throw new BlindfillError('LOCKED', `vault locked or session invalid: ${msg}`);
      if (/not found/i.test(msg)) throw new BlindfillError('NOT_FOUND', 'item not found');
      throw new BlindfillError('BACKEND', `bw ${args[0]} failed: ${msg}`);
    }
    return r.stdout;
  }

  async version(): Promise<string> {
    const r = await this.#run(this.#bin, ['--version']);
    if (r.code !== 0) throw new BlindfillError('BACKEND', 'bw --version failed');
    return r.stdout.trim().slice(0, 40);
  }

  async unlock(): Promise<void> {
    const out = await this.#bw(['status']);
    const st = parseJson<{ status?: string }>(out, 'bw status');
    if (st.status !== 'unlocked') throw new BlindfillError('LOCKED', `vault is ${st.status ?? 'unknown'}`);
  }

  protected async listRaw(q: FindQuery): Promise<BwRawItem[]> {
    let args: string[];
    if (q.target?.kind === 'web') args = ['list', 'items', '--url', q.target.origin + '/'];
    else if (q.target?.kind === 'android') args = ['list', 'items', '--search', q.target.pkg];
    else if (q.query !== undefined) args = ['list', 'items', '--search', q.query];
    else throw new BlindfillError('POLICY', 'find needs a target or a query');
    return parseJson<BwRawItem[]>(await this.#bw(args), 'bw list items');
  }

  protected async getRaw(ref: ItemRef): Promise<BwRawItem> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const raw = parseJson<BwRawItem>(await this.#bw(['get', 'item', ref.id]), 'bw get item');
    if (!raw || raw.id !== ref.id) throw new BlindfillError('NOT_FOUND', 'item not found');
    return raw;
  }

  protected async fetchTotp(ref: ItemRef): Promise<string> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    return this.#bw(['get', 'totp', ref.id]);
  }
}
