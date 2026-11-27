import { BlindfillError, type ItemRef } from '../core/types.js';
import type { Cap, FindQuery, ItemPatch, NewItemSpec } from './spi.js';
import { classifyBwFieldType } from '../core/fields.js';
import { globalScrubber } from '../core/scrubber.js';
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
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>([
    'SEARCH',
    'TOTP',
    'ANDROID_APPS',
    'CUSTOM_FIELDS',
    'WRITE',
  ]);
  #bin: string;
  #run: Runner;
  #env: NodeJS.ProcessEnv;

  constructor(opts: BwOptions = {}) {
    super();
    this.#env = opts.env ?? process.env;
    this.#bin = opts.bin ?? this.#env.BLINDFILL_BW_BIN ?? 'bw';
    this.#run = opts.runner ?? execRunner;
  }

  async #bw(args: string[], input?: string): Promise<string> {
    const session = this.#env.BW_SESSION;
    if (!session)
      throw new BlindfillError('LOCKED', 'BW_SESSION is not set (vault locked); unlock it outside blindfill');
    // session goes by environment, never on the command line (visible in ps)
    const r = await this.#run(this.#bin, [...args, '--nointeraction'], {
      env: { BW_SESSION: session, BW_NOINTERACTION: 'true' },
      input,
    });
    if (r.code !== 0) {
      // writes: stdout may be the item JSON we sent, so only stderr is ever quoted
      const write = args[0] === 'create' || args[0] === 'edit';
      const msg = safeErr(write ? r.stderr : r.stderr || r.stdout, [session]);
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

  // ---- writes (capability WRITE). The JSON body, which may hold a password, goes by stdin (never argv/ps). ----
  // Verified against the mock `bw` only; real `bw create/edit item` stdin handling is unverified here.

  #encode(body: unknown): string {
    return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  }

  async createItem(spec: NewItemSpec): Promise<ItemRef> {
    if (spec.password) globalScrubber.register(spec.password);
    if (spec.totpSeed) globalScrubber.register(spec.totpSeed);
    const body = {
      type: 1,
      name: spec.name,
      notes: null,
      favorite: false,
      fields: Object.entries(spec.fields ?? {}).map(([name, value]) => ({ name, value, type: 0 })),
      login: {
        username: spec.username ?? null,
        password: spec.password ?? null,
        totp: spec.totpSeed ?? null,
        uris: spec.uris.map((uri) => ({ uri, match: 1 })),
      },
    };
    const out = await this.#bw(['create', 'item'], this.#encode(body));
    const made = parseJson<BwRawItem>(out, 'bw create item');
    if (!made?.id || !ID_RE.test(made.id))
      throw new BlindfillError('BACKEND', 'bw create item returned no id');
    return { backend: this.id, id: made.id, name: spec.name };
  }

  /** `mutate` returns false when nothing needs writing. */
  async #edit(ref: ItemRef, mutate: (raw: BwRawItem) => void | false): Promise<void> {
    const raw = await this.getRaw(ref);
    // the whole item goes back to bw by stdin: know every secret in it in case bw echoes the body
    for (const v of [
      raw.login?.password,
      raw.login?.totp,
      raw.card?.number,
      raw.card?.code,
      raw.sshKey?.privateKey,
      ...(raw.login?.fido2Credentials ?? []).map((c) => c.keyValue),
    ])
      if (v) globalScrubber.register(v);
    for (const f of raw.fields ?? [])
      if (f.value && classifyBwFieldType(f.type) === 'secret') globalScrubber.register(f.value);
    if (mutate(raw) === false) return;
    await this.#bw(['edit', 'item', ref.id], this.#encode(raw));
  }

  async raisePasskeyCounter(ref: ItemRef, credentialId: string, counter: number): Promise<void> {
    await this.#edit(ref, (raw) => {
      const c = raw.login?.fido2Credentials?.[0];
      if (!c || c.credentialId !== credentialId)
        throw new BlindfillError('NOT_FOUND', 'the item no longer holds that passkey');
      if ((Number(c.counter ?? 0) || 0) >= counter) return false;
      c.counter = String(counter); // Bitwarden keeps the counter as a string
    });
  }

  async updateSecret(ref: ItemRef, field: string, value: string): Promise<void> {
    globalScrubber.register(value);
    await this.#edit(ref, (raw) => {
      if (field === 'password') {
        raw.login = { ...(raw.login ?? {}), password: value };
        return;
      }
      if (field === 'totp') {
        // add-only (owner decision 2026-11-27): an existing seed is never replaced
        if (raw.login?.totp) throw new BlindfillError('POLICY', 'this item already has a TOTP seed');
        raw.login = { ...(raw.login ?? {}), totp: value };
        return;
      }
      const f = raw.fields?.find((x) => x.name === field && classifyBwFieldType(x.type) === 'secret');
      if (!f) throw new BlindfillError('NOT_FOUND', 'item has no secret field with that name');
      f.value = value;
    });
  }

  async updateItem(ref: ItemRef, patch: ItemPatch): Promise<void> {
    await this.#edit(ref, (raw) => {
      if (patch.name !== undefined) raw.name = patch.name;
      if (patch.username !== undefined) raw.login = { ...(raw.login ?? {}), username: patch.username };
      if (patch.uris)
        raw.login = { ...(raw.login ?? {}), uris: patch.uris.map((uri) => ({ uri, match: 1 })) };
      for (const [name, value] of Object.entries(patch.fields ?? {})) {
        const fields = (raw.fields ??= []);
        const i = fields.findIndex((x) => x.name === name);
        if (i >= 0 && classifyBwFieldType(fields[i].type) === 'secret')
          throw new BlindfillError('SECRET_ACCESS', `"${name}" is a secret-class field: use a secret update`);
        if (value === null) {
          if (i >= 0) fields.splice(i, 1);
        } else if (i >= 0) fields[i].value = value;
        else fields.push({ name, value, type: 0 });
      }
    });
  }
}
