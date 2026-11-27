import { getDomain } from 'tldts';
import { BlindfillError, type ItemMeta, type ItemUri, type MatchType, type Target } from './types.js';

export interface MatchResult {
  ok: boolean;
  reason: string;
  uri?: string;
  match?: MatchType;
}

function parseUrl(s: string): URL | null {
  try {
    return new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return null;
  }
}

/** Loopback hosts (dev/test) are the only places a secret may be typed over plain http. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]';
}

function schemeCompatible(observed: URL, bound: URL): boolean {
  return observed.protocol === bound.protocol;
}

/**
 * Does the observed web origin satisfy one vault URI under Bitwarden match semantics?
 * `observedUrl` is the full URL the browser reports (needed for startsWith/exact/regex).
 */
export function matchUri(observedUrl: string, item: ItemUri): MatchResult {
  if (item.match === 'never') return { ok: false, reason: 'match type is "never"' };
  const obs = parseUrl(observedUrl);
  const bound = item.match === 'regex' ? obs : parseUrl(item.uri); // a regex is not a URL
  if (!obs || !bound) return { ok: false, reason: 'unparseable URL' };
  if (obs.protocol !== 'https:' && obs.protocol !== 'http:')
    return { ok: false, reason: 'not an http(s) page' };
  if (obs.protocol === 'http:' && !isLoopbackHost(obs.hostname))
    return { ok: false, reason: 'plain http outside loopback' };

  const hit = (): MatchResult => ({ ok: true, reason: 'match', uri: item.uri, match: item.match });
  const miss = (why: string): MatchResult => ({ ok: false, reason: why, uri: item.uri, match: item.match });

  switch (item.match) {
    case 'regex': {
      try {
        // anchored to avoid substring matches that Bitwarden-style unanchored regex would allow
        const re = new RegExp(`^(?:${item.uri})$`);
        return re.test(obs.href) ? hit() : miss('regex did not match');
      } catch {
        return miss('invalid regex');
      }
    }
    case 'exact': {
      const norm = (u: URL) => u.origin + u.pathname.replace(/\/$/, '') + u.search;
      return norm(obs) === norm(bound) ? hit() : miss('not an exact match');
    }
    case 'startsWith':
      if (!schemeCompatible(obs, bound)) return miss('scheme differs');
      // compare on a boundary so https://a.com/x does not accept https://a.com/xyz
      return obs.origin === bound.origin &&
        startsWithPath(obs.pathname + obs.search, bound.pathname + bound.search)
        ? hit()
        : miss('does not start with item URI');
    case 'domain': {
      if (!schemeCompatible(obs, bound)) return miss('scheme differs');
      const a = getDomain(obs.hostname);
      const b = getDomain(bound.hostname);
      if (a && b) return a === b && obs.port === bound.port ? hit() : miss('base domain differs');
      // IPs / localhost: fall back to host equality
      return obs.host === bound.host ? hit() : miss('host differs');
    }
    case 'host':
    default:
      if (!schemeCompatible(obs, bound)) return miss('scheme differs');
      return obs.host === bound.host ? hit() : miss('host differs');
  }
}

function startsWithPath(actual: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') return true;
  if (!actual.startsWith(prefix)) return false;
  if (prefix.endsWith('/')) return true;
  const next = actual.charAt(prefix.length);
  return next === '' || next === '/' || next === '?' || next === '#';
}

/** Web URIs only (androidapp:// entries are handled by android binding). */
export function webUris(meta: ItemMeta): ItemUri[] {
  return meta.uris.filter(
    (u) => /^https?:\/\//i.test(u.uri) || (!u.uri.includes('://') && u.match !== 'regex'),
  );
}

export function androidPackages(meta: ItemMeta): string[] {
  return meta.uris.map((u) => u.uri.match(/^androidapp:\/\/(.+)$/i)?.[1]).filter((x): x is string => !!x);
}

/** Origin binding for the page the browser is actually on. */
export function checkWebBinding(observedUrl: string, meta: ItemMeta): MatchResult {
  const uris = webUris(meta);
  if (uris.length === 0) return { ok: false, reason: 'item has no web URI to bind to' };
  let last: MatchResult = { ok: false, reason: 'no URI matched' };
  for (const u of uris) {
    const r = matchUri(observedUrl, u);
    if (r.ok) return r;
    last = r;
  }
  return { ok: false, reason: `origin not bound by item (${last.reason})` };
}

/** Like Bitwarden: the package must match; a blindfill.signers pin, when the item has one, must match too. */
export function checkAndroidBinding(pkg: string, signer: string | undefined, meta: ItemMeta): MatchResult {
  if (!androidPackages(meta).includes(pkg)) return { ok: false, reason: 'package not bound by item' };
  if (meta.control.signers.length === 0) return { ok: true, reason: 'package match (no signer pin)' };
  if (!signer) return { ok: false, reason: 'signer not observed' };
  const norm = (s: string) => s.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!meta.control.signers.map(norm).includes(norm(signer))) return { ok: false, reason: 'signer mismatch' };
  return { ok: true, reason: 'match' };
}

export function checkBinding(target: Target, meta: ItemMeta, observedUrl?: string): MatchResult {
  if (target.kind === 'web') return checkWebBinding(observedUrl ?? target.origin, meta);
  return checkAndroidBinding(target.pkg, target.signer, meta);
}

export function assertBound(r: MatchResult): void {
  if (!r.ok) throw new BlindfillError('ORIGIN_MISMATCH', r.reason);
}

/**
 * Per-session state: post-fill lock and one-shot guards.
 * A Secret fill locks the session: page text/DOM/screenshots are refused until stop.
 */
export class SessionPolicy {
  locked: boolean;
  /** Set while a human has the browser (CAPTCHA, consent, push-MFA). Agent-driven actions are refused. */
  paused: { reason: string; since: string } | null;
  private filled: Set<string>;

  constructor(init?: {
    locked?: boolean;
    filled?: string[];
    paused?: { reason: string; since: string } | null;
  }) {
    this.locked = init?.locked ?? false;
    this.paused = init?.paused ?? null;
    this.filled = new Set(init?.filled ?? []);
  }

  /** Every agent-driven browser action calls this first. */
  assertActive(what: string): void {
    if (this.paused)
      throw new BlindfillError(
        'POLICY',
        `session is paused for a human (${this.paused.reason}): refusing ${what}. Resume it with handoff resume.`,
      );
  }

  /** Call before returning page text, DOM, screenshots or console output. */
  assertReadable(what: string): void {
    if (this.locked)
      throw new BlindfillError(
        'SESSION_LOCKED',
        `session is locked after a secret fill: refusing ${what}. Stop the session (session_stop) to unlock.`,
      );
  }

  lock(): void {
    this.locked = true;
  }

  /** One-shot: a secret field is filled at most once per session+origin. */
  assertFirstSecretFill(origin: string, field: string): void {
    if (this.filled.has(`${origin}|${field}`))
      throw new BlindfillError(
        'POLICY',
        `secret field "${field}" was already filled on ${origin} in this session (one-shot). Stop the session to retry; blindfill never retries a failed login automatically.`,
      );
  }

  recordSecretFill(origin: string, field: string): void {
    this.filled.add(`${origin}|${field}`);
  }

  snapshot(): { locked: boolean; filled: string[]; paused: { reason: string; since: string } | null } {
    return { locked: this.locked, filled: [...this.filled], paused: this.paused };
  }
}

/** One submit per fill call. */
export class SubmitGuard {
  #used = false;
  take(): void {
    if (this.#used) throw new BlindfillError('POLICY', 'submit already performed for this call (one-shot)');
    this.#used = true;
  }
}
