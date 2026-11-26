import { classifyBwFieldType, isControlField } from '../core/fields.js';
import type { ItemMeta, ItemRef, ItemUri, MatchType } from '../core/types.js';
import { parseControl } from './spi.js';

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
export function mapBwItem(raw: BwRawItem, backendId = 'bw'): ItemMeta {
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
  const ref: ItemRef = { backend: backendId, id: raw.id, name: raw.name };
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
