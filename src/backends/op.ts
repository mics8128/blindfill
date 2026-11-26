import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery } from './spi.js';
import { execRunner, parseJson, safeErr, type Runner } from './runner.js';
import { RawItemBackend } from './rawitem.js';
import type { BwRawItem } from './bwmap.js';

interface OpField {
  label?: string;
  type?: string;
  purpose?: string;
  value?: string;
}
interface OpItem {
  id: string;
  title?: string;
  urls?: { href?: string }[];
  fields?: OpField[];
}

const READABLE_TYPES = new Set(['STRING', 'EMAIL', 'URL', 'PHONE', 'DATE', 'MONTH_YEAR']);
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** 1Password item JSON -> Bitwarden-shaped raw item. CONCEALED (and unknown) types stay Secret. */
export function opToRaw(i: OpItem): BwRawItem {
  const f = i.fields ?? [];
  const by = (p: string) => f.find((x) => x.purpose === p)?.value;
  return {
    id: i.id,
    name: i.title,
    type: 1,
    notes: by('NOTES') ?? null,
    login: {
      username: by('USERNAME'),
      password: by('PASSWORD'),
      totp: f.find((x) => x.type === 'OTP')?.value,
      uris: (i.urls ?? []).filter((u) => u.href).map((u) => ({ uri: u.href, match: null })),
    },
    fields: f
      .filter((x) => x.label && !x.purpose && x.type !== 'OTP')
      .map((x) => ({ name: x.label, value: x.value ?? '', type: READABLE_TYPES.has(x.type ?? '') ? 0 : 1 })),
  };
}

export interface OpOptions {
  bin?: string;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
}

/** 1Password CLI (`op`). Tier: blind-written/unverified. */
export class OpBackend extends RawItemBackend {
  readonly id = 'op';
  readonly tier = 'blind-written/unverified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'TOTP', 'CUSTOM_FIELDS']);
  #bin: string;
  #run: Runner;
  constructor(o: OpOptions = {}) {
    super();
    this.#bin = o.bin ?? 'op';
    this.#run = o.runner ?? execRunner;
  }

  async #op(args: string[]): Promise<string> {
    const r = await this.#run(this.#bin, args);
    if (r.code !== 0) {
      const msg = safeErr(r.stderr || r.stdout, [process.env.OP_SERVICE_ACCOUNT_TOKEN]);
      if (/not signed in|sign in|session expired|authoriz|locked|biometric/i.test(msg))
        throw new BlindfillError('LOCKED', `1Password is locked or not signed in: ${msg}`);
      if (/isn't an item|not found|no item/i.test(msg)) throw new BlindfillError('NOT_FOUND', 'item not found');
      throw new BlindfillError('BACKEND', `op ${args[0]} failed: ${msg}`);
    }
    return r.stdout;
  }
  async version(): Promise<string> {
    const r = await this.#run(this.#bin, ['--version']);
    if (r.code !== 0) throw new BlindfillError('BACKEND', 'op --version failed');
    return r.stdout.trim().slice(0, 40);
  }
  async unlock(): Promise<void> {
    await this.#op(['whoami', '--format', 'json']);
  }
  protected async listRaw(q: FindQuery): Promise<BwRawItem[]> {
    const list = parseJson<OpItem[]>(await this.#op(['item', 'list', '--categories', 'Login', '--format', 'json']), 'op item list');
    let hits = list;
    if (q.query !== undefined) hits = list.filter((i) => (i.title ?? '').toLowerCase().includes(q.query!.toLowerCase()));
    else if (q.target?.kind === 'web') {
      const host = new URL(q.target.origin).hostname;
      hits = list.filter((i) => (i.urls ?? []).some((u) => u.href?.includes(host.split('.').slice(-2).join('.'))));
    } else if (q.target?.kind === 'android') hits = list.filter((i) => (i.urls ?? []).some((u) => u.href?.includes(q.target!.kind === 'android' ? (q.target as { pkg: string }).pkg : '')));
    else throw new BlindfillError('POLICY', 'find needs a target or a query');
    return Promise.all(hits.slice(0, 25).map((i) => this.getRaw({ backend: 'op', id: i.id })));
  }
  protected async getRaw(ref: ItemRef): Promise<BwRawItem> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const it = parseJson<OpItem>(await this.#op(['item', 'get', ref.id, '--format', 'json']), 'op item get');
    if (!it || it.id !== ref.id) throw new BlindfillError('NOT_FOUND', 'item not found');
    return opToRaw(it);
  }
  protected async fetchTotp(ref: ItemRef): Promise<string> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    return this.#op(['item', 'get', ref.id, '--otp']);
  }
}
