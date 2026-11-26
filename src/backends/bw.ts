import { classifyBwFieldType, isControlField } from '../core/fields.js';
import { SecretHandle } from '../core/secret.js';
import { globalScrubber } from '../core/scrubber.js';
import { checkWebBinding, androidPackages } from '../core/policy.js';
import {
  BlindfillError,
  type ItemMeta,
  type ItemRef,
  type ItemUri,
  type MatchType,
} from '../core/types.js';
import { parseControl, type Backend, type Cap, type FindQuery } from './spi.js';
import { execRunner, parseJson, safeErr, type Runner } from './runner.js';

/** Bitwarden match-type enum. null/undefined => default => Host (stricter than Bitwarden's base domain). */
const MATCH: Record<number, MatchType> = {
  0: 'domain',
  1: 'host',
  2: 'startsWith',
  3: 'exact',
  4: 'regex',
  5: 'never',
};

export interface BwRawItem {
  id: string;
  name?: string;
  type?: number; // 1 login, 2 note, 3 card, 4 identity, 5 ssh key
  notes?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null; match?: number | null }[] | null;
  } | null;
  card?: Record<string, string | null> | null;
  sshKey?: { privateKey?: string | null; publicKey?: string | null } | null;
  fields?: { name?: string; value?: string | null; type?: number }[] | null;
}

/** Map Bitwarden item JSON to ItemMeta. Secret VALUES are dropped here; only names survive. */
export function mapBwItem(raw: BwRawItem): ItemMeta {
  const uris: ItemUri[] = (raw.login?.uris ?? [])
    .filter((u) => !!u.uri)
    .map((u) => ({ uri: u.uri as string, match: u.match == null ? 'host' : (MATCH[u.match] ?? 'never') }));
  const readable: Record<string, string> = {};
  const secretFields: string[] = [];
  const controlRaw: Record<string, string> = {};
  if (raw.login?.password) secretFields.push('password');
  if (raw.card?.number) secretFields.push('card.number');
  if (raw.card?.code) secretFields.push('card.code');
  if (raw.sshKey?.privateKey) secretFields.push('ssh.privateKey');
  if (raw.card?.cardholderName) readable['card.holder'] = raw.card.cardholderName;
  if (raw.sshKey?.publicKey) readable['ssh.publicKey'] = raw.sshKey.publicKey;
  for (const f of raw.fields ?? []) {
    if (!f.name) continue;
    if (isControlField(f.name)) {
      controlRaw[f.name] = f.value ?? '';
      continue;
    }
    if (classifyBwFieldType(f.type) === 'readable') readable[f.name] = f.value ?? '';
    else secretFields.push(f.name);
  }
  const control = parseControl(controlRaw);
  const ref: ItemRef = { backend: 'bw', id: raw.id, name: raw.name };
  return {
    ref,
    name: raw.name ?? '',
    username: raw.login?.username ?? undefined,
    uris,
    readable,
    secretFields,
    hasTotp: !!raw.login?.totp,
    control,
    notes: control.notesReadable ? (raw.notes ?? undefined) : undefined,
  };
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface BwOptions {
  bin?: string;
  runner?: Runner;
  /** override env var source (tests) */
  env?: NodeJS.ProcessEnv;
}

export class BwBackend implements Backend {
  readonly id = 'bw';
  readonly tier = 'verified' as const;
  readonly capabilities: ReadonlySet<Cap> = new Set<Cap>(['SEARCH', 'TOTP', 'ANDROID_APPS', 'CUSTOM_FIELDS']);
  #bin: string;
  #run: Runner;
  #env: NodeJS.ProcessEnv;

  constructor(opts: BwOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#bin = opts.bin ?? this.#env.BLINDFILL_BW_BIN ?? 'bw';
    this.#run = opts.runner ?? execRunner;
  }

  async #bw(args: string[]): Promise<string> {
    const session = this.#env.BW_SESSION;
    if (!session) throw new BlindfillError('LOCKED', 'BW_SESSION is not set (vault locked); unlock it outside blindfill');
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

  async #raw(ref: ItemRef): Promise<BwRawItem> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const raw = parseJson<BwRawItem>(await this.#bw(['get', 'item', ref.id]), 'bw get item');
    if (!raw || raw.id !== ref.id) throw new BlindfillError('NOT_FOUND', 'item not found');
    return raw;
  }

  async find(q: FindQuery): Promise<ItemRef[]> {
    let args: string[];
    if (q.target?.kind === 'web') args = ['list', 'items', '--url', q.target.origin + '/'];
    else if (q.target?.kind === 'android') args = ['list', 'items', '--search', q.target.pkg];
    else if (q.query !== undefined) args = ['list', 'items', '--search', q.query];
    else throw new BlindfillError('POLICY', 'find needs a target or a query');
    const items = parseJson<BwRawItem[]>(await this.#bw(args), 'bw list items');
    const out: ItemRef[] = [];
    for (const raw of items) {
      const m = mapBwItem(raw);
      if (q.target?.kind === 'web' && !checkWebBinding(q.target.origin + '/', m).ok) continue;
      if (q.target?.kind === 'android' && !androidPackages(m).includes(q.target.pkg)) continue;
      out.push(m.ref);
    }
    return out;
  }

  async meta(ref: ItemRef): Promise<ItemMeta> {
    return mapBwItem(await this.#raw(ref));
  }

  async read(ref: ItemRef, field: string): Promise<string> {
    const m = await this.meta(ref);
    if (field === 'username') return m.username ?? '';
    if (field === 'name') return m.name;
    if (field in m.readable) return m.readable[field];
    throw new BlindfillError(
      'SECRET_ACCESS',
      m.secretFields.includes(field)
        ? `"${field}" is a secret-class field: it can be filled but never read`
        : `no readable field "${field}"`,
    );
  }

  async openSecret(ref: ItemRef, field: string): Promise<SecretHandle> {
    const raw = await this.#raw(ref);
    const m = mapBwItem(raw);
    if (!m.secretFields.includes(field)) throw new BlindfillError('NOT_FOUND', `no secret field "${field}"`);
    let value: string | null | undefined;
    if (field === 'password') value = raw.login?.password;
    else if (field === 'card.number') value = raw.card?.number;
    else if (field === 'card.code') value = raw.card?.code;
    else if (field === 'ssh.privateKey') value = raw.sshKey?.privateKey;
    else value = raw.fields?.find((f) => f.name === field && classifyBwFieldType(f.type) === 'secret')?.value;
    if (!value) throw new BlindfillError('NOT_FOUND', `secret field "${field}" is empty`);
    globalScrubber.register(value);
    return new SecretHandle(value, field);
  }

  async totpCode(ref: ItemRef): Promise<string> {
    if (!ID_RE.test(ref.id)) throw new BlindfillError('NOT_FOUND', 'invalid item id');
    const code = (await this.#bw(['get', 'totp', ref.id])).trim();
    if (!/^\d{6,8}$/.test(code)) throw new BlindfillError('BACKEND', 'bw returned an unexpected TOTP value');
    return code;
  }
}
