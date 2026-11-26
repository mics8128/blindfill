import { isControlField } from '../core/fields.js';
import type { BwRawItem } from './bwmap.js';

/**
 * Shared parser for backends whose items are flat key/value text (pass, gopass, keepassxc, secret-service).
 * These formats carry no field *types*, so the rule is: only well-known keys and keys the item
 * explicitly lists in `blindfill.readable` are Readable. Everything else is Secret (fail closed).
 */
export interface KV {
  key: string;
  value: string;
}

const USER_KEYS = new Set(['username', 'user', 'login', 'email']);
const URL_KEYS = /^(url|uri|website|site)\d*$/i;

export function kvToRaw(
  id: string,
  name: string,
  password: string | undefined,
  kvs: KV[],
  notes?: string,
): BwRawItem {
  const readableList = new Set(
    kvs
      .filter((k) => k.key.toLowerCase() === 'blindfill.readable')
      .flatMap((k) => k.value.split(/[,\s]+/))
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
  let username: string | undefined;
  let totp: string | undefined;
  const uris: { uri: string; match: null }[] = [];
  const fields: { name: string; value: string; type: number }[] = [];
  for (const { key, value } of kvs) {
    const k = key.trim();
    const lk = k.toLowerCase();
    if (lk === 'blindfill.readable') continue;
    if (USER_KEYS.has(lk) && username === undefined) username = value;
    else if (URL_KEYS.test(k)) uris.push({ uri: value.trim(), match: null });
    else if (lk === 'otpauth' || lk === 'otp' || lk === 'totp' || value.startsWith('otpauth://'))
      totp = value;
    else if (isControlField(k)) fields.push({ name: k, value, type: 0 });
    else fields.push({ name: k, value, type: readableList.has(lk) ? 0 : 1 });
  }
  return { id, name, type: 1, notes: notes ?? null, login: { username, password, totp, uris }, fields };
}

/** Parse "Key: value" lines. Lines without a colon are returned as notes. */
export function parseKvLines(text: string): { kvs: KV[]; notes: string } {
  const kvs: KV[] = [];
  const notes: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('otpauth://')) {
      kvs.push({ key: 'otpauth', value: line.trim() });
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_. -]{1,60}):\s?(.*)$/);
    if (m && !/^https?$/i.test(m[1])) kvs.push({ key: m[1].trim(), value: m[2] });
    else notes.push(line);
  }
  return { kvs, notes: notes.join('\n') };
}
