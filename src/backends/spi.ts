import type { SecretHandle } from '../core/secret.js';
import type { ControlFields, ItemMeta, ItemRef, Target } from '../core/types.js';

export type Cap = 'SEARCH' | 'TOTP' | 'ANDROID_APPS' | 'CUSTOM_FIELDS' | 'WRITE';
export type Tier = 'verified' | 'blind-written/unverified' | 'community-verified';

export interface FindQuery {
  /** Resolve items whose vault URIs bind to this target (policy-filtered). */
  target?: Target;
  /** Free-text search (name / username / URI). */
  query?: string;
}

/** ARCHITECTURE 3.1. Every backend must pass src/backends/_contract. */
export interface Backend {
  readonly id: string;
  readonly tier: Tier;
  readonly capabilities: ReadonlySet<Cap>;
  /** Vendor CLI version string, for selftest / issue reports. Never contains secrets. */
  version(): Promise<string>;
  /** Non-interactive readiness check. Throws BlindfillError('LOCKED') when the vault is locked. */
  unlock(): Promise<void>;
  /** Metadata only. */
  find(q: FindQuery): Promise<ItemRef[]>;
  /** Readable values + Secret field NAMES. Never values of Secret-class fields. */
  meta(ref: ItemRef): Promise<ItemMeta>;
  /** Readable-class fields only. Throws SECRET_ACCESS for Secret-class fields. */
  read(ref: ItemRef, field: string): Promise<string>;
  /** Secret-class value as a write-only handle. */
  openSecret(ref: ItemRef, field: string): Promise<SecretHandle>;
  /** Current TOTP code (Ephemeral). The seed never leaves the backend. */
  totpCode(ref: ItemRef): Promise<string>;
}

export const DEFAULT_CONTROL: ControlFields = {
  submit: 'once',
  signers: [],
  notesReadable: false,
  registration: false,
};

/** Parse blindfill.* control fields given as name -> value. Shared by backends. */
export function parseControl(fields: Record<string, string>): ControlFields {
  const c: ControlFields = { ...DEFAULT_CONTROL, signers: [] };
  for (const [k, v] of Object.entries(fields)) {
    const key = k.toLowerCase();
    if (key === 'blindfill.submit') c.submit = v.trim().toLowerCase() === 'none' ? 'none' : 'once';
    else if (key === 'blindfill.signers')
      c.signers = v
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    else if (key === 'blindfill.notes') c.notesReadable = v.trim().toLowerCase() === 'readable';
    else if (key === 'blindfill.registration') c.registration = v.trim().toLowerCase() === 'allow';
    else if (key === 'blindfill.password_policy') {
      try {
        c.passwordPolicy = JSON.parse(v);
      } catch {
        c.passwordPolicy = undefined;
      }
    } else if (key === 'blindfill.rules') {
      try {
        c.rules = JSON.parse(v);
      } catch {
        c.rules = undefined; // malformed rules are ignored, never guessed
      }
    }
  }
  return c;
}
