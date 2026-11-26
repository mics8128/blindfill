import { describe, expect, it } from 'vitest';
import {
  pick,
  pickNamed,
  scoreRole,
  THRESHOLD,
  type FieldDescriptor,
} from '../src/actuators/web/heuristics.js';
import { assertLoopbackEndpoint, assertSafeEvidenceSelector } from '../src/actuators/web/web.js';

const d = (o: Partial<FieldDescriptor>): { desc: FieldDescriptor } => ({
  desc: {
    tag: 'input',
    type: 'text',
    name: '',
    id: '',
    autocomplete: '',
    ariaLabel: '',
    placeholder: '',
    label: '',
    inputmode: '',
    maxlength: 0,
    reasons: [],
    disabled: false,
    readOnly: false,
    ...o,
  },
});

describe('heuristics', () => {
  it('detects password, username, totp by attributes', () => {
    const all = [
      d({ type: 'email', name: 'email', autocomplete: 'username' }),
      d({ type: 'password', autocomplete: 'current-password' }),
      d({ name: 'otp', autocomplete: 'one-time-code', maxlength: 6 }),
    ];
    expect(pick(all, 'password')).toMatchObject({ kind: 'ok', item: all[1] });
    expect(pick(all, 'username')).toMatchObject({ kind: 'ok', item: all[0] });
    expect(pick(all, 'totp')).toMatchObject({ kind: 'ok', item: all[2] });
  });
  it('labels and aria count when attributes are generic', () => {
    const all = [
      d({ name: 'f1', label: 'Email address' }),
      d({ type: 'password', name: 'f2', ariaLabel: 'Password' }),
    ];
    expect(pick(all, 'username').kind).toBe('ok');
    expect(pick(all, 'password').kind).toBe('ok');
  });
  it('below threshold => none; never picks a non-password input as password', () => {
    expect(pick([d({ name: 'q', label: 'Search' })], 'username').kind).toBe('none');
    expect(scoreRole(d({ type: 'text', name: 'password' }).desc, 'password')).toBe(0);
    expect(pick([d({ type: 'password' })], 'password')).toMatchObject({ kind: 'ok' });
    expect(THRESHOLD).toBeGreaterThan(0);
  });
  it('hidden/honeypot candidates are never chosen', () => {
    const hp = d({ type: 'password', autocomplete: 'current-password', reasons: ['not-visible'] });
    expect(pick([hp], 'password').kind).toBe('none');
    const real = d({ type: 'password', autocomplete: 'current-password' });
    expect(pick([hp, real], 'password')).toMatchObject({ kind: 'ok', item: real });
  });
  it('near ties are ambiguous', () => {
    const a = d({ type: 'password', name: 'password' });
    const b = d({ type: 'password', name: 'password' });
    expect(pick([a, b], 'password').kind).toBe('ambiguous');
  });
  it('confirm/new password is demoted', () => {
    const cur = d({ type: 'password', name: 'password', autocomplete: 'current-password' });
    const nw = d({ type: 'password', name: 'new_password', autocomplete: 'new-password' });
    expect(pick([nw, cur], 'password')).toMatchObject({ kind: 'ok', item: cur });
  });
  it('named fields: exact beats partial; unknown => none', () => {
    const all = [d({ name: 'store_id' }), d({ name: 'storage' })];
    expect(pickNamed(all, 'store_id')).toMatchObject({ kind: 'ok', item: all[0] });
    expect(pickNamed(all, 'zzz').kind).toBe('none');
  });
});

describe('guards', () => {
  it('CDP endpoints must be loopback', () => {
    expect(() => assertLoopbackEndpoint('http://127.0.0.1:9222')).not.toThrow();
    expect(() => assertLoopbackEndpoint('http://localhost:9222')).not.toThrow();
    expect(() => assertLoopbackEndpoint('http://[::1]:9222')).not.toThrow();
    expect(() => assertLoopbackEndpoint('http://10.0.0.5:9222')).toThrow(/loopback/);
    expect(() => assertLoopbackEndpoint('http://evil.example.com:9222')).toThrow(/loopback/);
    expect(() => assertLoopbackEndpoint('http://127.0.0.1.evil.com:9222')).toThrow(/loopback/);
    expect(() => assertLoopbackEndpoint('nonsense')).toThrow();
  });
  it('evidence selectors cannot probe values or use pseudos', () => {
    for (const ok of ['#welcome', '.flash.error', 'div[role="alert"]', 'h1'])
      expect(() => assertSafeEvidenceSelector(ok)).not.toThrow();
    for (const bad of [
      'input[value^="a"]',
      'p:has-text("x")',
      'text=secret',
      'a:nth-child(2)',
      'x'.repeat(200),
    ])
      expect(() => assertSafeEvidenceSelector(bad)).toThrow();
  });
});
