import { classifyBwFieldType } from '../core/fields.js';
import { androidPackages, checkWebBinding } from '../core/policy.js';
import { globalScrubber } from '../core/scrubber.js';
import { SecretHandle } from '../core/secret.js';
import { BlindfillError, type ItemMeta, type ItemRef } from '../core/types.js';
import { mapBwItem, type BwRawItem } from './bwmap.js';
import type { Backend, Cap, FindQuery, Tier } from './spi.js';

/** Pull one Secret-class value out of a raw item. Used only inside backends. */
export function secretValueFromRaw(raw: BwRawItem, field: string): string | null | undefined {
  if (field === 'password') return raw.login?.password;
  if (field === 'card.number') return raw.card?.number;
  if (field === 'card.code') return raw.card?.code;
  if (field === 'ssh.privateKey') return raw.sshKey?.privateKey;
  return raw.fields?.find((f) => f.name === field && classifyBwFieldType(f.type) === 'secret')?.value;
}

/**
 * Shared behaviour for backends that can produce a Bitwarden-shaped raw item. A backend only
 * implements how to list/get raw items and a TOTP code; classification, binding filter,
 * read-refusal and handle creation live here, so every backend behaves identically.
 */
export abstract class RawItemBackend implements Backend {
  abstract readonly id: string;
  abstract readonly tier: Tier;
  abstract readonly capabilities: ReadonlySet<Cap>;
  abstract version(): Promise<string>;
  abstract unlock(): Promise<void>;
  protected abstract listRaw(q: FindQuery): Promise<BwRawItem[]>;
  protected abstract getRaw(ref: ItemRef): Promise<BwRawItem>;
  protected abstract fetchTotp(ref: ItemRef): Promise<string>;

  async find(q: FindQuery): Promise<ItemRef[]> {
    const out: ItemRef[] = [];
    for (const raw of await this.listRaw(q)) {
      const m = mapBwItem(raw, this.id);
      if (q.target?.kind === 'web' && !checkWebBinding(q.target.origin + '/', m).ok) continue;
      if (q.target?.kind === 'android' && !androidPackages(m).includes(q.target.pkg)) continue;
      out.push(m.ref);
    }
    return out;
  }

  async meta(ref: ItemRef): Promise<ItemMeta> {
    return mapBwItem(await this.getRaw(ref), this.id);
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
    const raw = await this.getRaw(ref);
    const m = mapBwItem(raw, this.id);
    if (!m.secretFields.includes(field)) throw new BlindfillError('NOT_FOUND', `no secret field "${field}"`);
    const value = secretValueFromRaw(raw, field);
    if (!value) throw new BlindfillError('NOT_FOUND', `secret field "${field}" is empty`);
    globalScrubber.register(value);
    return new SecretHandle(value, field);
  }

  async totpCode(ref: ItemRef): Promise<string> {
    if (!this.capabilities.has('TOTP')) throw new BlindfillError('UNSUPPORTED', `${this.id} has no TOTP support`);
    const code = (await this.fetchTotp(ref)).trim();
    if (!/^\d{6,8}$/.test(code)) throw new BlindfillError('BACKEND', `${this.id} returned an unexpected TOTP value`);
    return code;
  }
}
