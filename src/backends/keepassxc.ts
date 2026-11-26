import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery } from './spi.js';
import { execRunner, safeErr, type Runner } from './runner.js';
import { RawItemBackend } from './rawitem.js';
import type { BwRawItem } from './bwmap.js';
import { kvToRaw, parseKvLines } from './textfmt.js';

export interface KeepassOptions {
  bin?: string;
  runner?: Runner;
  /** path to the .kdbx file (or BLINDFILL_KEEPASS_DB) */
  db?: string;
  keyFile?: string;
  env?: NodeJS.ProcessEnv;
}

const validId = (id: string) => /^(?!-)[^\n\r\0]{1,300}$/.test(id);

/**
 * keepassxc-cli. The database password comes from BLINDFILL_KEEPASS_PASSWORD (fed on stdin, never argv).
 * KeePass custom attributes carry no protected-flag via the CLI, so they are Secret unless the entry
 * lists them in a `blindfill.readable` attribute. Tier: blind-written/unverified.
 */
export class KeepassxcBackend extends RawItemBackend {
  readonly id = 'keepassxc';
  readonly tier = 'blind-written/unverified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'TOTP', 'CUSTOM_FIELDS']);
  #bin: string;
  #run: Runner;
  #db?: string;
  #key?: string;
  #env: NodeJS.ProcessEnv;
  constructor(o: KeepassOptions = {}) {
    super();
    this.#env = o.env ?? process.env;
    this.#bin = o.bin ?? 'keepassxc-cli';
    this.#run = o.runner ?? execRunner;
    this.#db = o.db ?? this.#env.BLINDFILL_KEEPASS_DB;
    this.#key = o.keyFile ?? this.#env.BLINDFILL_KEEPASS_KEYFILE;
  }
  async #kp(sub: string, rest: string[], extra: string[] = []): Promise<string> {
    if (!this.#db) throw new BlindfillError('LOCKED', 'no database configured (BLINDFILL_KEEPASS_DB)');
    const pw = this.#env.BLINDFILL_KEEPASS_PASSWORD;
    if (pw === undefined && !this.#key) throw new BlindfillError('LOCKED', 'BLINDFILL_KEEPASS_PASSWORD (or a key file) is required');
    const args = [sub, '-q', ...(this.#key ? ['-k', this.#key] : []), ...extra, this.#db, ...rest];
    const r = await this.#run(this.#bin, args, { input: pw !== undefined ? pw + '\n' : '\n' });
    if (r.code !== 0) {
      const msg = safeErr(r.stderr || r.stdout, [pw]);
      if (/invalid credentials|wrong|unable to open|master key|password/i.test(msg)) throw new BlindfillError('LOCKED', `database not unlocked: ${msg}`);
      if (/could not find|not found|no results/i.test(msg)) throw new BlindfillError('NOT_FOUND', 'item not found');
      throw new BlindfillError('BACKEND', `keepassxc-cli ${sub} failed: ${msg}`);
    }
    return r.stdout;
  }
  async version(): Promise<string> {
    const r = await this.#run(this.#bin, ['--version']);
    if (r.code !== 0) throw new BlindfillError('BACKEND', 'keepassxc-cli --version failed');
    return r.stdout.trim().slice(0, 40);
  }
  async unlock(): Promise<void> {
    await this.#kp('ls', [], ['-R', '-f']);
  }
  protected async listRaw(q: FindQuery): Promise<BwRawItem[]> {
    const names = (await this.#kp('ls', [], ['-R', '-f'])).split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/'));
    let hits: string[];
    if (q.query !== undefined) hits = names.filter((n) => n.toLowerCase().includes(q.query!.toLowerCase()));
    else if (q.target?.kind === 'web') hits = names; // URL lives in the entry; the binding filter decides
    else throw new BlindfillError('POLICY', 'find needs a web target or a query');
    return Promise.all(hits.slice(0, 40).map((id) => this.getRaw({ backend: 'keepassxc', id })));
  }
  protected async getRaw(ref: ItemRef): Promise<BwRawItem> {
    if (!validId(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const text = await this.#kp('show', [ref.id], ['-s']);
    const { kvs } = parseKvLines(text);
    const get = (k: string) => kvs.find((x) => x.key.toLowerCase() === k)?.value;
    const rest = kvs.filter((x) => !['title', 'username', 'password', 'url', 'notes', 'uuid', 'tags'].includes(x.key.toLowerCase()));
    const kv = [
      ...(get('username') ? [{ key: 'username', value: get('username') as string }] : []),
      ...(get('url') ? [{ key: 'url', value: get('url') as string }] : []),
      ...rest,
    ];
    return kvToRaw(ref.id, get('title') ?? ref.id, get('password') || undefined, kv, get('notes'));
  }
  protected async fetchTotp(ref: ItemRef): Promise<string> {
    if (!validId(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    return this.#kp('show', [ref.id], ['-t']);
  }
}
