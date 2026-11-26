import { inspect } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SecretHandle,
  Scrubber,
  SessionPolicy,
  SubmitGuard,
  audit,
  checkAndroidBinding,
  checkWebBinding,
  classifyBwFieldType,
  classifyKey,
  formatTarget,
  matchUri,
  parseTarget,
  type ItemMeta,
} from '../src/core/index.js';

const PW = 'p@ss w0rd/+&="é"\\';

describe('classifier', () => {
  it('unknown => secret; known builtins classed', () => {
    expect(classifyKey('username')).toBe('readable');
    expect(classifyKey('password')).toBe('secret');
    expect(classifyKey('totp')).toBe('secret');
    expect(classifyKey('totp.code')).toBe('ephemeral');
    expect(classifyKey('notes')).toBe('notes');
    expect(classifyKey('something-new')).toBe('secret');
    expect(classifyKey('constructor')).toBe('secret');
    expect(classifyKey('__proto__')).toBe('secret');
  });
  it('bitwarden field types', () => {
    expect(classifyBwFieldType(0)).toBe('readable');
    expect(classifyBwFieldType(2)).toBe('readable');
    expect(classifyBwFieldType(1)).toBe('secret');
    expect(classifyBwFieldType(3)).toBe('secret');
    expect(classifyBwFieldType(undefined)).toBe('secret');
    expect(classifyBwFieldType(99)).toBe('secret');
  });
});

describe('targets', () => {
  it('round trips', () => {
    expect(formatTarget(parseTarget('web:https://a.example.com/path?x=1'))).toBe('web:https://a.example.com');
    const t = parseTarget('android:com.instagram.android#sha256=5f:3e');
    expect(formatTarget(t)).toBe('android:com.instagram.android#sha256=5F:3E');
    expect(() => parseTarget('ftp://x')).toThrow();
    expect(() => parseTarget('android:bad')).toThrow();
  });
});

describe('SecretHandle', () => {
  it('does not leak via string, JSON, inspect, template, console formatting', () => {
    const h = new SecretHandle(PW, 'password');
    expect(() => String(h)).toThrow();
    expect(() => h.toString()).toThrow();
    expect(() => JSON.stringify({ h })).toThrow();
    expect(() => `${h}`).toThrow();
    expect(() => h + '').toThrow();
    expect(inspect(h)).not.toContain('p@ss');
    expect(inspect({ nested: h }, { depth: 5, showHidden: true })).not.toContain('p@ss');
    expect(Object.keys(h)).not.toContain('buf');
    expect(Object.getOwnPropertyNames(h).join()).not.toMatch(/buf/);
    expect(h.length).toBe(Buffer.byteLength(PW));
  });
  it('into() runs once and zero-fills', async () => {
    const h = new SecretHandle(PW);
    let kept: Buffer | undefined;
    let got = '';
    await h.into((b) => {
      kept = b;
      got = b.toString('utf8');
    });
    expect(got).toBe(PW);
    expect(kept!.every((x) => x === 0)).toBe(true);
    expect(h.consumed).toBe(true);
    await expect(h.into(() => undefined)).rejects.toMatchObject({ code: 'SECRET_ACCESS' });
  });
  it('zero-fills even if the sink throws', async () => {
    const h = new SecretHandle('abcdef');
    let kept: Buffer | undefined;
    await expect(
      h.into((b) => {
        kept = b;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(kept!.every((x) => x === 0)).toBe(true);
  });
});

describe('scrubber', () => {
  const s = new Scrubber();
  s.register(PW);
  const forms: Record<string, string> = {
    raw: PW,
    urlenc: encodeURIComponent(PW),
    form: encodeURIComponent(PW).replace(/%20/g, '+'),
    json: JSON.stringify(PW),
    jsonInJson: JSON.stringify(JSON.stringify({ p: PW })),
    b64: Buffer.from(PW).toString('base64'),
    b64url: Buffer.from(PW).toString('base64url'),
    hex: Buffer.from(PW).toString('hex'),
  };
  for (const [name, v] of Object.entries(forms)) {
    it(`scrubs ${name}`, () => {
      const out = s.scrub(`before ${v} after`);
      expect(out).not.toContain(v);
      expect(out).toContain('[REDACTED]');
    });
  }
  it('scrubs base64 at every alignment inside a larger blob', () => {
    for (const prefix of ['', 'a', 'ab', 'abc', 'user:', 'xy=']) {
      for (const suffix of ['', 'z', 'zz', '&next=1']) {
        const blob = Buffer.from(prefix + PW + suffix).toString('base64');
        const out = s.scrub(`Authorization: Basic ${blob}`);
        expect(s.contains(out), `${prefix}|${suffix}`).toBe(false);
      }
    }
  });
  it('scrubDeep covers nested objects and keys', () => {
    const o = s.scrubDeep({ a: [PW, { [PW]: 1 }], n: 3 });
    expect(JSON.stringify(o)).not.toContain('w0rd');
  });
  it('ignores very short values', () => {
    const t = new Scrubber();
    t.register('ab');
    expect(t.scrub('ab ab')).toBe('ab ab');
  });
});

describe('audit', () => {
  it('appends JSONL, never values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-audit-'));
    const p = join(dir, 'a.jsonl');
    audit(
      {
        event: 'fill',
        backend: 'bw',
        item: 'id1',
        target: 'web:https://x.test',
        fields: ['password'],
        outcome: 'ok',
      },
      p,
    );
    audit({ event: 'refused', reason: 'origin' }, p);
    const lines = readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'fill', fields: ['password'] });
    expect(lines[0].ts).toBeTruthy();
  });
});

const meta = (uris: { uri: string; match: any }[], extra: Partial<ItemMeta> = {}): ItemMeta => ({
  ref: { backend: 'bw', id: 'i' },
  name: 'n',
  uris,
  readable: {},
  secretFields: ['password'],
  hasTotp: false,
  control: { submit: 'once', signers: [], notesReadable: false },
  ...extra,
});

describe('policy: match types', () => {
  it('host (default)', () => {
    const u = { uri: 'https://accounts.example.com/login', match: 'host' as const };
    expect(matchUri('https://accounts.example.com/other', u).ok).toBe(true);
    expect(matchUri('https://www.example.com/', u).ok).toBe(false);
    expect(matchUri('https://accounts.example.com.evil.test/', u).ok).toBe(false);
    expect(matchUri('http://accounts.example.com/', u).ok).toBe(false); // downgrade
    expect(matchUri('https://accounts.example.com:8443/', u).ok).toBe(false);
    expect(matchUri('https://evil.test/?u=accounts.example.com', u).ok).toBe(false);
  });
  it('base domain', () => {
    const u = { uri: 'https://www.example.co.uk', match: 'domain' as const };
    expect(matchUri('https://login.example.co.uk/', u).ok).toBe(true);
    expect(matchUri('https://other.co.uk/', u).ok).toBe(false);
    expect(matchUri('https://example.co.uk.evil.test/', u).ok).toBe(false);
  });
  it('startsWith on a path boundary', () => {
    const u = { uri: 'https://a.test/app', match: 'startsWith' as const };
    expect(matchUri('https://a.test/app/login', u).ok).toBe(true);
    expect(matchUri('https://a.test/app', u).ok).toBe(true);
    expect(matchUri('https://a.test/application', u).ok).toBe(false);
    expect(matchUri('https://a.test/', u).ok).toBe(false);
  });
  it('exact', () => {
    const u = { uri: 'https://a.test/login', match: 'exact' as const };
    expect(matchUri('https://a.test/login', u).ok).toBe(true);
    expect(matchUri('https://a.test/login/', u).ok).toBe(true);
    expect(matchUri('https://a.test/login?x=1', u).ok).toBe(false);
    expect(matchUri('https://a.test/', u).ok).toBe(false);
  });
  it('regex is anchored; invalid regex fails closed', () => {
    const u = { uri: 'https://[a-z]+\\.corp\\.test/.*', match: 'regex' as const };
    expect(matchUri('https://eu.corp.test/login', u).ok).toBe(true);
    expect(matchUri('https://eu.corp.test.evil.test/login', u).ok).toBe(false);
    expect(matchUri('https://evil.test/https://eu.corp.test/x', u).ok).toBe(false);
    expect(matchUri('https://a.test', { uri: '(', match: 'regex' }).ok).toBe(false);
  });
  it('never', () => {
    expect(matchUri('https://a.test/', { uri: 'https://a.test', match: 'never' }).ok).toBe(false);
  });
  it('checkWebBinding: no web uri => refuse; any matching uri => ok', () => {
    expect(checkWebBinding('https://a.test/', meta([])).ok).toBe(false);
    expect(
      checkWebBinding('https://a.test/', meta([{ uri: 'androidapp://com.x.y', match: 'host' }])).ok,
    ).toBe(false);
    expect(
      checkWebBinding(
        'https://b.test/',
        meta([
          { uri: 'https://a.test', match: 'host' },
          { uri: 'https://b.test', match: 'host' },
        ]),
      ).ok,
    ).toBe(true);
  });
  it('android binding needs package + pinned signer', () => {
    const m = meta([{ uri: 'androidapp://com.x.y', match: 'host' }], {
      control: { submit: 'once', signers: ['aa:bb:cc'], notesReadable: false },
    });
    expect(checkAndroidBinding('com.x.y', 'AABBCC', m).ok).toBe(true);
    expect(checkAndroidBinding('com.x.y', 'AABBCD', m).ok).toBe(false);
    expect(checkAndroidBinding('com.x.z', 'AABBCC', m).ok).toBe(false);
    expect(checkAndroidBinding('com.x.y', undefined, m).ok).toBe(false);
    expect(checkAndroidBinding('com.x.y', 'AABBCC', meta(m.uris)).ok).toBe(false);
  });
});

describe('policy: session', () => {
  it('lock refuses reads; one-shot secret fill; one submit per call', () => {
    const p = new SessionPolicy();
    expect(() => p.assertReadable('page text')).not.toThrow();
    p.lock();
    expect(() => p.assertReadable('page text')).toThrowError(/locked/);
    p.assertFirstSecretFill('https://a.test', 'password');
    p.recordSecretFill('https://a.test', 'password');
    expect(() => p.assertFirstSecretFill('https://a.test', 'password')).toThrow(/one-shot/);
    expect(() => p.assertFirstSecretFill('https://b.test', 'password')).not.toThrow();
    const q = new SessionPolicy(p.snapshot());
    expect(q.locked).toBe(true);
    expect(() => q.assertFirstSecretFill('https://a.test', 'password')).toThrow();
    const g = new SubmitGuard();
    g.take();
    expect(() => g.take()).toThrow();
  });
});
