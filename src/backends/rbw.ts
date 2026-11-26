import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery } from './spi.js';
import { execRunner, parseJson, safeErr, type Runner } from './runner.js';
import { RawItemBackend } from './rawitem.js';
import type { BwRawItem } from './bwmap.js';

interface RbwItem {
  id: string;
  name?: string;
  notes?: string | null;
  data?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string; match_type?: string | null }[] | null;
  } | null;
  fields?: { name?: string; value?: string | null; type?: string }[] | null;
}

const MATCH: Record<string, number> = {
  domain: 0,
  host: 1,
  starts_with: 2,
  exact: 3,
  regular_expression: 4,
  never: 5,
};
const FTYPE: Record<string, number> = { text: 0, hidden: 1, boolean: 2, linked: 3 };
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function rbwToRaw(i: RbwItem): BwRawItem {
  return {
    id: i.id,
    name: i.name,
    type: 1,
    notes: i.notes ?? null,
    login: {
      username: i.data?.username,
      password: i.data?.password,
      totp: i.data?.totp,
      uris: (i.data?.uris ?? []).map((u) => ({
        uri: u.uri,
        match: u.match_type ? (MATCH[u.match_type] ?? 5) : null,
      })),
    },
    // unknown / missing types => undefined => Secret
    fields: (i.fields ?? []).map((f) => ({ name: f.name, value: f.value ?? '', type: FTYPE[f.type ?? ''] })),
  };
}

export interface RbwOptions {
  bin?: string;
  runner?: Runner;
}

/** rbw (unofficial Bitwarden CLI with an agent). Tier: blind-written/unverified. */
export class RbwBackend extends RawItemBackend {
  readonly id = 'rbw';
  readonly tier = 'blind-written/unverified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'TOTP', 'ANDROID_APPS', 'CUSTOM_FIELDS']);
  #bin: string;
  #run: Runner;
  constructor(o: RbwOptions = {}) {
    super();
    this.#bin = o.bin ?? 'rbw';
    this.#run = o.runner ?? execRunner;
  }
  async #rbw(args: string[]): Promise<string> {
    const r = await this.#run(this.#bin, args, { env: { RBW_NONINTERACTIVE: '1' } });
    if (r.code !== 0) {
      const msg = safeErr(r.stderr || r.stdout);
      if (/locked|unlock|pinentry|not logged in|agent/i.test(msg))
        throw new BlindfillError('LOCKED', `rbw vault is locked: ${msg}`);
      if (/no entry|not found|couldn't find/i.test(msg))
        throw new BlindfillError('NOT_FOUND', 'item not found');
      throw new BlindfillError('BACKEND', `rbw ${args[0]} failed: ${msg}`);
    }
    return r.stdout;
  }
  async version(): Promise<string> {
    const r = await this.#run(this.#bin, ['--version']);
    if (r.code !== 0) throw new BlindfillError('BACKEND', 'rbw --version failed');
    return r.stdout.trim().slice(0, 40);
  }
  async unlock(): Promise<void> {
    const r = await this.#run(this.#bin, ['unlocked']);
    if (r.code !== 0) throw new BlindfillError('LOCKED', 'rbw vault is locked (run `rbw unlock` yourself)');
  }
  protected async listRaw(q: FindQuery): Promise<BwRawItem[]> {
    const rows = (await this.#rbw(['list', '--fields', 'id,name,user']))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    let ids: string[];
    if (q.query !== undefined)
      ids = rows.filter((r) => (r[1] ?? '').toLowerCase().includes(q.query!.toLowerCase())).map((r) => r[0]);
    else if (q.target) {
      // rbw list cannot show URIs: scan up to 50 entries and let the binding filter decide
      ids = rows.slice(0, 50).map((r) => r[0]);
    } else throw new BlindfillError('POLICY', 'find needs a target or a query');
    return Promise.all(ids.slice(0, 50).map((id) => this.getRaw({ backend: 'rbw', id })));
  }
  protected async getRaw(ref: ItemRef): Promise<BwRawItem> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const it = parseJson<RbwItem>(await this.#rbw(['get', '--raw', ref.id]), 'rbw get');
    if (!it || it.id !== ref.id) throw new BlindfillError('NOT_FOUND', 'item not found');
    return rbwToRaw(it);
  }
  protected async fetchTotp(ref: ItemRef): Promise<string> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    return this.#rbw(['code', ref.id]);
  }
}
