/**
 * Scrubber: removes known Secret values from any outgoing text in these forms:
 * raw, URL-encoded (%20 and +), Base64 / Base64url (all three alignments), hex, JSON-escaped.
 * Best effort: it cannot defeat transformations it does not know (see SECURITY.md).
 */
export const REDACTED = '[REDACTED]';
const MIN_LEN = 4;

function b64Variants(buf: Buffer): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const total = k + buf.length;
    let s = Buffer.concat([Buffer.alloc(k), buf]).toString('base64');
    s = s.replace(/=+$/, '');
    const dropHead = k === 0 ? 0 : k === 1 ? 2 : 3;
    s = s.slice(dropHead);
    if (total % 3 !== 0) s = s.slice(0, -1);
    if (s.length >= 4) {
      out.push(s);
      out.push(s.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return out;
}

function forms(value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  const set = new Set<string>([value]);
  set.add(encodeURIComponent(value));
  set.add(encodeURIComponent(value).replace(/%20/g, '+'));
  set.add(encodeURI(value));
  set.add(JSON.stringify(value).slice(1, -1));
  set.add(buf.toString('hex'));
  set.add(buf.toString('hex').toUpperCase());
  // also the escaped-twice JSON form (secret inside a JSON string inside JSON)
  set.add(JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1));
  for (const b of b64Variants(buf)) set.add(b);
  return [...set].filter((s) => s.length >= MIN_LEN);
}

export class Scrubber {
  #needles: string[] = [];
  #seen = new Set<string>();

  /** Register a Secret value (string or Buffer). The Buffer is not retained; derived strings are. */
  register(value: string | Buffer): void {
    const s = typeof value === 'string' ? value : value.toString('utf8');
    if (s.length < MIN_LEN || this.#seen.has(s)) return;
    this.#seen.add(s);
    this.#needles.push(...forms(s));
    // longest first so superstrings win
    this.#needles.sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.#seen.size;
  }

  scrub(text: string): string {
    let out = text;
    for (const n of this.#needles) {
      if (out.includes(n)) out = out.split(n).join(REDACTED);
    }
    return out;
  }

  /**
   * Output boundary. A redaction marker shows that, and where, a secret matched the text (e.g. a
   * caller-supplied guess echoed in an error), so any hit withholds the whole text instead.
   */
  guard(text: string, withheld: string): string {
    return this.scrub(text) === text && !text.includes(REDACTED) ? text : withheld;
  }

  /** Scrub every string in a JSON-able value (keys too). */
  scrubDeep<T>(v: T): T {
    if (typeof v === 'string') return this.scrub(v) as unknown as T;
    if (Array.isArray(v)) return v.map((x) => this.scrubDeep(x)) as unknown as T;
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[this.scrub(k)] = this.scrubDeep(x);
      return o as T;
    }
    return v;
  }

  contains(text: string): boolean {
    return this.#needles.some((n) => text.includes(n));
  }
}

/** Process-wide scrubber shared by backends, engine, CLI and MCP. */
export const globalScrubber = new Scrubber();
