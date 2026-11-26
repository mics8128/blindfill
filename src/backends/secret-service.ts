import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery } from './spi.js';
import { execRunner, safeErr, type Runner } from './runner.js';
import { RawItemBackend } from './rawitem.js';
import type { BwRawItem } from './bwmap.js';
import { kvToRaw, type KV } from './textfmt.js';

const PATH_RE = /^\/org\/freedesktop\/secrets\/[A-Za-z0-9_/]+$/;

export interface SecretServiceOptions {
  bin?: string;
  runner?: Runner;
}

/**
 * freedesktop Secret Service via `secret-tool`. Items are those stored with the attribute `blindfill 1`:
 *   secret-tool store --label="Fake Shop" blindfill 1 username alice uri https://shop.example.test/login
 * Attributes `username`, `uri`/`url` are Readable; any other attribute is Secret unless listed in the
 * attribute `blindfill.readable`. No TOTP. Tier: blind-written/unverified.
 */
export class SecretServiceBackend extends RawItemBackend {
  readonly id = 'secret-service';
  readonly tier = 'blind-written/unverified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'CUSTOM_FIELDS']);
  #bin: string;
  #run: Runner;
  constructor(o: SecretServiceOptions = {}) {
    super();
    this.#bin = o.bin ?? 'secret-tool';
    this.#run = o.runner ?? execRunner;
  }
  async version(): Promise<string> {
    const r = await this.#run(this.#bin, ['--version']);
    if (r.code !== 0 && !r.stdout && !r.stderr) throw new BlindfillError('BACKEND', 'secret-tool not runnable');
    return (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 60);
  }
  async #all(): Promise<BwRawItem[]> {
    const r = await this.#run(this.#bin, ['search', '--all', 'blindfill', '1']);
    if (r.code !== 0) {
      const msg = safeErr(r.stderr || r.stdout);
      if (/locked|cancel|denied|no such secret collection|prompt/i.test(msg)) throw new BlindfillError('LOCKED', `keyring locked: ${msg}`);
      if (r.code === 1 && !r.stdout.trim()) return [];
      throw new BlindfillError('BACKEND', `secret-tool search failed: ${msg}`);
    }
    const out: BwRawItem[] = [];
    for (const block of r.stdout.split(/^(?=\[\/)/m)) {
      const path = block.match(/^\[(\/[^\]]+)\]/)?.[1];
      if (!path || !PATH_RE.test(path)) continue;
      const label = block.match(/^label = (.*)$/m)?.[1] ?? path;
      const secret = block.match(/^secret = (.*)$/m)?.[1];
      const kvs: KV[] = [...block.matchAll(/^attribute\.([^ =]+) = (.*)$/gm)]
        .map((m) => ({ key: m[1], value: m[2] }))
        .filter((k) => k.key !== 'blindfill' && k.key !== 'xdg:schema');
      out.push(kvToRaw(path, label, secret || undefined, kvs));
    }
    return out;
  }
  async unlock(): Promise<void> {
    await this.#all();
  }
  protected async listRaw(q: FindQuery): Promise<BwRawItem[]> {
    const all = await this.#all();
    if (q.query !== undefined) return all.filter((i) => (i.name ?? '').toLowerCase().includes(q.query!.toLowerCase()));
    if (q.target) return all;
    throw new BlindfillError('POLICY', 'find needs a target or a query');
  }
  protected async getRaw(ref: ItemRef): Promise<BwRawItem> {
    if (!PATH_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const it = (await this.#all()).find((i) => i.id === ref.id);
    if (!it) throw new BlindfillError('NOT_FOUND', 'item not found');
    return it;
  }
  protected async fetchTotp(): Promise<string> {
    throw new BlindfillError('UNSUPPORTED', 'secret-service has no TOTP support');
  }
}
