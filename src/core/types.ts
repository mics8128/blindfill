/** Shared types. A Target is what an actuator *observed*, never what the caller claims. */

export type WebTarget = { kind: 'web'; origin: string };
export type AndroidTarget = { kind: 'android'; pkg: string; signer?: string };
export type Target = WebTarget | AndroidTarget;

export function formatTarget(t: Target): string {
  return t.kind === 'web' ? `web:${t.origin}` : `android:${t.pkg}${t.signer ? `#sha256=${t.signer}` : ''}`;
}

export function parseTarget(s: string): Target {
  if (s.startsWith('web:')) {
    const origin = new URL(s.slice(4)).origin;
    if (origin === 'null') throw new Error('web target needs an http(s) origin');
    return { kind: 'web', origin };
  }
  if (s.startsWith('android:')) {
    const [pkg, rest] = s.slice(8).split('#');
    const m = rest?.match(/^sha256=(.+)$/i);
    if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(pkg)) throw new Error('invalid android package');
    return { kind: 'android', pkg, signer: m ? m[1].toUpperCase() : undefined };
  }
  // bare URL convenience
  if (/^https?:\/\//.test(s)) return { kind: 'web', origin: new URL(s).origin };
  throw new Error(`unrecognised target "${s}" (use web:<origin> or android:<pkg>#sha256=<hex>)`);
}

/** Bitwarden URI match types. null/undefined in the vault means "default" => we use Host. */
export type MatchType = 'domain' | 'host' | 'startsWith' | 'exact' | 'regex' | 'never';

export interface ItemUri {
  uri: string;
  match: MatchType;
}

export interface ItemRef {
  backend: string;
  id: string;
  name?: string;
}

export type SubmitPolicy = 'once' | 'none';

/** Parsed blindfill.* control fields. */
export interface ControlFields {
  submit: SubmitPolicy;
  signers: string[];
  rules?: unknown;
  notesReadable: boolean;
}

/**
 * Item metadata that is safe to hand to an agent: readable values, secret-field NAMES only.
 */
export interface ItemMeta {
  ref: ItemRef;
  name: string;
  username?: string;
  uris: ItemUri[];
  /** Readable custom fields (Text/Boolean) with values. */
  readable: Record<string, string>;
  /** Names of Secret-class fields (never values). Includes "password" when present. */
  secretFields: string[];
  hasTotp: boolean;
  control: ControlFields;
  /** Only populated when the item opts in with blindfill.notes=readable. */
  notes?: string;
}

export class BlindfillError extends Error {
  constructor(
    public code:
      | 'LOCKED'
      | 'NOT_FOUND'
      | 'ORIGIN_MISMATCH'
      | 'POLICY'
      | 'AMBIGUOUS'
      | 'SESSION_LOCKED'
      | 'BACKEND'
      | 'ACTUATOR'
      | 'UNSUPPORTED'
      | 'SECRET_ACCESS',
    message: string,
  ) {
    super(message);
    this.name = 'BlindfillError';
  }
}
