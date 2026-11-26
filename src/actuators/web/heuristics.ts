/** Pure scoring of form-field descriptors. No DOM, no values: structure only. */

export type Role = 'username' | 'password' | 'totp';

export interface FieldDescriptor {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  ariaLabel: string;
  placeholder: string;
  label: string;
  inputmode: string;
  maxlength: number;
  /** Why the element is not a legitimate target (honeypot / hidden). Empty => usable. */
  reasons: string[];
  disabled: boolean;
  readOnly: boolean;
}

export const THRESHOLD = 50;
const AMBIGUITY_MARGIN = 10;

function blob(d: FieldDescriptor): string {
  return [d.name, d.id, d.label, d.placeholder, d.ariaLabel].join(' ').toLowerCase();
}

export function scoreRole(d: FieldDescriptor, role: Role): number {
  const b = blob(d);
  const ac = d.autocomplete.toLowerCase();
  const idish = [d.name, d.id].join(' ').toLowerCase();
  const text = [d.label, d.placeholder, d.ariaLabel].join(' ').toLowerCase();
  let s = 0;
  if (role === 'password') {
    if (d.type === 'password') s += 60;
    else return 0; // a non-password input is never a password target
    if (/current-password/.test(ac)) s += 30;
    if (/new-password/.test(ac)) s -= 15;
    if (/pass|pwd/.test(idish)) s += 15;
    if (/pass|pwd/.test(text)) s += 10;
    if (/confirm|repeat|retype|again|new/.test(b)) s -= 25;
  } else if (role === 'username') {
    if (!['text', 'email', 'tel', 'search', ''].includes(d.type)) return 0;
    if (/\busername\b|\bemail\b/.test(ac)) s += 45;
    if (d.type === 'email') s += 15;
    if (/user|login|email|e-mail|account|member|signin|handle|phone/.test(idish)) s += 25;
    if (/user|login|email|e-mail|account|member|phone/.test(text)) s += 20;
    if (d.type === 'text' || d.type === '') s += 5;
    if (/search|query|captcha|coupon|promo|otp|code|token|zip|postal|first|last|company|city/.test(b)) s -= 60;
    if (d.type === 'search') s -= 40;
  } else {
    if (!['text', 'tel', 'number', 'password', ''].includes(d.type)) return 0;
    if (/one-time-code/.test(ac)) s += 60;
    if (/otp|totp|2fa|mfa|two.?factor|one.?time|verification|authenticator|security.?code|passcode/.test(b)) s += 35;
    else if (/\bcode\b|token/.test(b)) s += 20;
    if (/numeric|tel/.test(d.inputmode) || d.type === 'tel') s += 8;
    if (d.maxlength >= 4 && d.maxlength <= 8) s += 15;
    if (/coupon|promo|zip|postal|search|captcha/.test(b)) s -= 60;
    if (/current-password|new-password/.test(ac)) s -= 60;
  }
  return Math.max(0, s);
}

export interface Scored<T> {
  item: T;
  score: number;
}

export type Pick<T> =
  | { kind: 'ok'; item: T; score: number }
  | { kind: 'none'; best: number }
  | { kind: 'ambiguous'; items: T[] };

/** Choose the single best usable candidate for a role. Below threshold or near-tie => stop. */
export function pick<T extends { desc: FieldDescriptor }>(all: T[], role: Role): Pick<T> {
  const usable = all.filter((c) => c.desc.reasons.length === 0 && !c.desc.disabled && !c.desc.readOnly);
  const scored: Scored<T>[] = usable
    .map((item) => ({ item, score: scoreRole(item.desc, role) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || scored[0].score < THRESHOLD) return { kind: 'none', best: scored[0]?.score ?? 0 };
  const near = scored.filter((s) => s.score >= THRESHOLD && scored[0].score - s.score < AMBIGUITY_MARGIN);
  if (near.length > 1) return { kind: 'ambiguous', items: near.map((n) => n.item) };
  return { kind: 'ok', item: scored[0].item, score: scored[0].score };
}

/** Explicit-name matching for custom fields (names come from the vault item). */
export function scoreNamed(d: FieldDescriptor, fieldName: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(fieldName);
  if (!want) return 0;
  let s = 0;
  for (const v of [d.name, d.id, d.label, d.ariaLabel, d.placeholder]) {
    const n = norm(v);
    if (!n) continue;
    if (n === want) s = Math.max(s, 80);
    else if (n.includes(want) && want.length >= 4) s = Math.max(s, 55);
  }
  return s;
}

export function pickNamed<T extends { desc: FieldDescriptor }>(all: T[], fieldName: string): Pick<T> {
  const usable = all.filter((c) => c.desc.reasons.length === 0 && !c.desc.disabled && !c.desc.readOnly);
  const scored = usable
    .map((item) => ({ item, score: scoreNamed(item.desc, fieldName) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || scored[0].score < THRESHOLD) return { kind: 'none', best: scored[0]?.score ?? 0 };
  const near = scored.filter((s) => scored[0].score - s.score < AMBIGUITY_MARGIN);
  if (near.length > 1) return { kind: 'ambiguous', items: near.map((n) => n.item) };
  return { kind: 'ok', item: scored[0].item, score: scored[0].score };
}
