/**
 * Field classes (ARCHITECTURE 2a) and the classifier. Unknown => Secret.
 */
export type FieldClass = 'secret' | 'ephemeral' | 'readable' | 'notes';

const BUILTIN: Record<string, FieldClass> = {
  username: 'readable',
  name: 'readable',
  uri: 'readable',
  uris: 'readable',
  folder: 'readable',
  collection: 'readable',
  password: 'secret',
  totp: 'secret', // the SEED. The current code is 'totp.code' (ephemeral)
  'totp.code': 'ephemeral',
  notes: 'notes',
  'card.number': 'secret',
  'card.code': 'secret',
  'card.cvv': 'secret',
  'card.holder': 'readable',
  'card.expMonth': 'readable',
  'card.expYear': 'readable',
  'ssh.privateKey': 'secret',
  'ssh.publicKey': 'readable',
};

/** Classify a built-in field key. Anything unrecognised is Secret (fail closed). */
export function classifyKey(key: string): FieldClass {
  return Object.prototype.hasOwnProperty.call(BUILTIN, key) ? BUILTIN[key] : 'secret';
}

/**
 * Bitwarden custom field types: 0 Text, 1 Hidden, 2 Boolean, 3 Linked.
 * Text/Boolean => Readable. Hidden, Linked, unknown/missing => Secret.
 */
export function classifyBwFieldType(type: unknown): FieldClass {
  return type === 0 || type === 2 ? 'readable' : 'secret';
}

export const CONTROL_PREFIX = 'blindfill.';
export function isControlField(name: string): boolean {
  return name.toLowerCase().startsWith(CONTROL_PREFIX);
}

export function isReadable(c: FieldClass): boolean {
  return c === 'readable' || c === 'ephemeral';
}
