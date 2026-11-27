/**
 * Data-only password policies and CSPRNG password generation.
 * Candidate values are never logged; generated values are handed straight to a backend write.
 */
import { randomInt } from 'node:crypto';
import { BlindfillError } from './core/types.js';

export interface PasswordPolicy {
  version: 1;
  min_length?: number;
  max_length?: number;
  min_uppercase?: number;
  min_lowercase?: number;
  min_digits?: number;
  min_special?: number;
  max_consecutive_identical?: number;
  allowed_special?: string;
  exclude_characters?: string;
}

const DEFAULTS = {
  version: 1,
  min_length: 8,
  max_length: 128,
  min_uppercase: 1,
  min_lowercase: 1,
  min_digits: 1,
  min_special: 1,
  max_consecutive_identical: 128,
  allowed_special: '-_!',
  exclude_characters: '',
};
type Cfg = typeof DEFAULTS;
const COUNTS = ['min_lowercase', 'min_uppercase', 'min_digits', 'min_special'] as const;
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

const invalid = (): never => {
  throw new BlindfillError('POLICY', 'invalid password policy');
};
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function configuration(value: unknown, length?: number): { c: Cfg; length: number; pools: string[] } {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid();
  for (const k of Object.keys(raw)) if (!(k in DEFAULTS)) invalid();
  if (value !== undefined && value !== null && raw.version !== 1) invalid();
  const c = { ...DEFAULTS, ...raw } as Cfg;
  for (const k of ['min_length', 'max_length', ...COUNTS, 'max_consecutive_identical'] as const)
    if (!isInt(c[k])) invalid();
  if (!(8 <= c.min_length && c.min_length <= c.max_length && c.max_length <= 128)) invalid();
  if (
    COUNTS.some((k) => !(0 <= c[k] && c[k] <= 128)) ||
    !(1 <= c.max_consecutive_identical && c.max_consecutive_identical <= 128)
  )
    invalid();
  const symbols = c.allowed_special;
  const excluded = c.exclude_characters;
  if (
    typeof symbols !== 'string' ||
    symbols.length > 32 ||
    new Set(symbols).size !== symbols.length ||
    [...symbols].some((ch) => !PUNCT.includes(ch)) ||
    typeof excluded !== 'string' ||
    excluded.length > 128 ||
    [...excluded].some((ch) => !(LOWER + UPPER + DIGITS + PUNCT).includes(ch))
  )
    invalid();
  const pools = [LOWER, UPPER, DIGITS, symbols].map((p) =>
    [...p].filter((ch) => !excluded.includes(ch)).join(''),
  );
  if (COUNTS.some((k, i) => c[k] && !pools[i]) || !pools.join('')) invalid();
  const need = COUNTS.reduce((a, k) => a + c[k], 0);
  if (need > c.max_length) invalid();
  const run = c.max_consecutive_identical;
  const feasible = (n: number): boolean => {
    if (need > n) return false;
    if (pools.join('').length === 1 && n > run) return false;
    return COUNTS.every((k, i) => pools[i].length !== 1 || c[k] <= run * (n - c[k] + 1));
  };
  let len = length;
  if (len === undefined) {
    const preferred = Math.min(c.max_length, Math.max(32, c.min_length, need));
    const order: number[] = [];
    for (let n = preferred; n <= c.max_length; n++) order.push(n);
    for (let n = preferred - 1; n >= c.min_length; n--) order.push(n);
    len = order.find(feasible);
  }
  if (!isInt(len) || len < c.min_length || len > c.max_length || !feasible(len)) invalid();
  return { c, length: len as number, pools };
}

export function validatePasswordPolicy(value: unknown): PasswordPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  configuration(value);
  return JSON.parse(JSON.stringify(value)) as PasswordPolicy;
}

export function passwordMatches(value: string, policy?: PasswordPolicy | null, length?: number): boolean {
  const { c, length: selected, pools } = configuration(policy ?? undefined, length);
  if (typeof value !== 'string' || value.length < c.min_length || value.length > c.max_length) return false;
  if (length !== undefined && value.length !== selected) return false;
  const alphabet = pools.join('');
  if ([...value].some((ch) => !alphabet.includes(ch))) return false;
  if (COUNTS.some((k, i) => [...value].filter((ch) => pools[i].includes(ch)).length < c[k])) return false;
  const run = c.max_consecutive_identical;
  for (let i = 0; i + run < value.length; i++)
    if (new Set(value.slice(i, i + run + 1)).size === 1) return false;
  return true;
}

const choice = <T>(a: ArrayLike<T>): T => a[randomInt(a.length)];

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
}

/** Randomised feasible ordering under a run limit (not uniform over constrained strings). */
function orderWithRunLimit(chars: string[], run: number): string | null {
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const size = chars.length;
  for (const n of counts.values()) if (n > run * (size - n + 1)) return null;
  const out: string[] = [];
  let last: string | null = null;
  let repeated = 0;
  while (counts.size) {
    const candidates: string[] = [];
    const remaining = [...counts.values()].reduce((a, b) => a + b, 0) - 1;
    for (const ch of counts.keys()) {
      const newRun = ch === last ? repeated + 1 : 1;
      if (newRun > run) continue;
      let ok = true;
      for (const [other, n] of counts) {
        const m = n - (other === ch ? 1 : 0);
        if (m > run * (remaining - m) + (other === ch ? run - newRun : run)) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push(ch);
    }
    if (!candidates.length) return null;
    const sel = choice(candidates);
    repeated = sel === last ? repeated + 1 : 1;
    last = sel;
    out.push(sel);
    const left = (counts.get(sel) as number) - 1;
    if (left) counts.set(sel, left);
    else counts.delete(sel);
  }
  return out.join('');
}

export function generatePassword(policy?: PasswordPolicy | null, length?: number): string {
  const { c, length: selected, pools } = configuration(policy ?? undefined, length);
  const alphabet = pools.join('');
  for (let attempt = 0; attempt < 512; attempt++) {
    const chars: string[] = [];
    COUNTS.forEach((k, i) => {
      for (let n = 0; n < c[k]; n++) chars.push(choice(pools[i]));
    });
    while (chars.length < selected) chars.push(choice(alphabet));
    shuffle(chars);
    const candidate =
      c.max_consecutive_identical >= selected
        ? chars.join('')
        : orderWithRunLimit(chars, c.max_consecutive_identical);
    chars.fill('');
    if (candidate !== null && passwordMatches(candidate, policy, selected)) return candidate;
  }
  throw new BlindfillError('POLICY', 'password generation failed');
}
