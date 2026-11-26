import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery } from './spi.js';
import { execRunner, safeErr, type Runner } from './runner.js';
import { RawItemBackend } from './rawitem.js';
import type { BwRawItem } from './bwmap.js';
import { kvToRaw, parseKvLines } from './textfmt.js';

const ID_RE = /^(?!-)(?!\/)[A-Za-z0-9._@+ /-]{1,200}$/;
const validId = (id: string) => ID_RE.test(id) && !id.split('/').includes('..');

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${e}/`));
    else if (e.endsWith('.gpg')) out.push(prefix + e.slice(0, -4));
  }
  return out;
}

export interface PassOptions {
  variant?: 'pass' | 'gopass';
  bin?: string;
  runner?: Runner;
  /** list entry names (injectable for tests). Defaults: gopass => `gopass ls --flat`; pass => walk the store dir. */
  lister?: () => Promise<string[]>;
}

/**
 * pass / gopass. Entry format: first line = password; then `key: value` lines; `otpauth://` line = TOTP seed;
 * `url:`, `username:`; `blindfill.readable: a, b` declares which other keys are readable (default: none).
 * Tier: blind-written/unverified.
 */
export class PassBackend extends RawItemBackend {
  readonly id: string;
  readonly tier = 'blind-written/unverified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'TOTP', 'CUSTOM_FIELDS']);
  #variant: 'pass' | 'gopass';
  #bin: string;
  #run: Runner;
  #lister: () => Promise<string[]>;
  constructor(o: PassOptions = {}) {
    super();
    this.#variant = o.variant ?? 'pass';
    this.id = this.#variant;
    this.#bin = o.bin ?? this.#variant;
    this.#run = o.runner ?? execRunner;
    this.#lister =
      o.lister ??
      (async () => {
        if (this.#variant === 'gopass')
          return (await this.#cmd(['ls', '--flat']))
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        return walk(process.env.PASSWORD_STORE_DIR ?? join(homedir(), '.password-store'));
      });
  }
  async #cmd(args: string[]): Promise<string> {
    const r = await this.#run(this.#bin, args, {
      env: { GPG_TTY: '', PINENTRY_USER_DATA: 'blindfill-noninteractive' },
    });
    if (r.code !== 0) {
      const msg = safeErr(r.stderr || r.stdout);
      if (/not in the password store|entry not found|not found/i.test(msg))
        throw new BlindfillError('NOT_FOUND', 'item not found');
      if (/decrypt|pinentry|no secret key|locked|cancel|passphrase|agent/i.test(msg))
        throw new BlindfillError('LOCKED', `store locked or cannot decrypt: ${msg}`);
      throw new BlindfillError('BACKEND', `${this.#variant} ${args[0]} failed: ${msg}`);
    }
    return r.stdout;
  }
  async version(): Promise<string> {
    const r = await this.#run(this.#bin, ['--version']);
    if (r.code !== 0) throw new BlindfillError('BACKEND', `${this.#variant} --version failed`);
    return r.stdout.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  /** pass has no lock state: list the store, then decrypt the first entry to prove gpg can unlock. */
  async unlock(): Promise<void> {
    const names = await this.#lister().catch((e) => {
      if (e instanceof BlindfillError) throw e;
      throw new BlindfillError('BACKEND', 'password store not readable');
    });
    if (names[0]) await this.getRaw({ backend: this.id, id: names[0] });
  }
  protected async listRaw(q: FindQuery): Promise<BwRawItem[]> {
    const names = await this.#lister();
    let hits: string[];
    if (q.query !== undefined) hits = names.filter((n) => n.toLowerCase().includes(q.query!.toLowerCase()));
    else if (q.target?.kind === 'web') {
      const labels = new URL(q.target.origin).hostname.split('.');
      const needle = (labels.length > 1 ? labels[labels.length - 2] : labels[0]).toLowerCase();
      hits = names.filter((n) => n.toLowerCase().includes(needle));
    } else if (q.target?.kind === 'android')
      hits = names.filter((n) =>
        n.includes(q.target!.kind === 'android' ? (q.target as { pkg: string }).pkg : ''),
      );
    else throw new BlindfillError('POLICY', 'find needs a target or a query');
    return Promise.all(hits.slice(0, 20).map((id) => this.getRaw({ backend: this.id, id })));
  }
  protected async getRaw(ref: ItemRef): Promise<BwRawItem> {
    if (!validId(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const text = await this.#cmd(this.#variant === 'gopass' ? ['show', '-f', ref.id] : ['show', ref.id]);
    const [first = '', ...rest] = text.replace(/\r/g, '').split('\n');
    const { kvs, notes } = parseKvLines(rest.join('\n'));
    return kvToRaw(ref.id, ref.id.split('/').pop() ?? ref.id, first || undefined, kvs, notes);
  }
  protected async fetchTotp(ref: ItemRef): Promise<string> {
    if (!validId(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    return this.#cmd(this.#variant === 'gopass' ? ['otp', '-o', ref.id] : ['otp', ref.id]);
  }
}
