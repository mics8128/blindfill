import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBackendContract } from '../src/backends/_contract/index.js';
import { bwFixtureItems, FAKE } from '../src/backends/_contract/fixtures.js';
import { BwBackend, mapBwItem } from '../src/backends/bw.js';

const MOCK = resolve('tests/fixtures/mock-bw.mjs');

runBackendContract(
  'bw',
  async ({ locked }) => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-mockbw-'));
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify(bwFixtureItems()));
    process.env.BLINDFILL_MOCK_BW_ITEMS = file;
    const env = { ...process.env, BW_SESSION: locked ? undefined : 'mock-session-token' };
    return {
      backend: new BwBackend({ bin: MOCK, env }),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  { hiddenFields: true, totp: true, android: true },
);

describe('bw item mapping', () => {
  it('maps match types, null => host, control fields not exposed as readable', () => {
    const raw = {
      id: 'x',
      name: 'n',
      login: {
        username: 'u',
        password: 'p-secret-value',
        uris: [
          { uri: 'https://a.test', match: 0 },
          { uri: 'https://b.test', match: 3 },
          { uri: 'https://c.test', match: null },
          { uri: 'androidapp://com.x.y', match: null },
        ],
      },
      fields: [
        { name: 'blindfill.submit', value: 'none', type: 0 },
        { name: 'blindfill.notes', value: 'readable', type: 0 },
        { name: 'linked', value: null, type: 3 },
        { name: 'untyped', value: 'v' },
        { name: 'flag', value: 'true', type: 2 },
      ],
      notes: 'note text',
    };
    const m = mapBwItem(raw);
    expect(m.uris.map((u) => u.match)).toEqual(['domain', 'exact', 'host', 'host']);
    expect(m.control.submit).toBe('none');
    expect(m.notes).toBe('note text');
    expect(m.readable).toEqual({ flag: 'true' });
    expect(m.secretFields).toEqual(['password', 'linked', 'untyped']); // unknown => secret
    expect(JSON.stringify(m)).not.toContain('p-secret-value');
  });

  it('notes are hidden by default', () => {
    expect(mapBwItem({ id: 'x', notes: 'n', login: {} }).notes).toBeUndefined();
  });

  it('never passes BW_SESSION on the command line', async () => {
    const calls: string[][] = [];
    const b = new BwBackend({
      env: { BW_SESSION: 'sess-token-123' },
      runner: async (_bin, args, o) => {
        calls.push(args);
        expect(o?.env?.BW_SESSION).toBe('sess-token-123');
        return { code: 0, stdout: JSON.stringify([]), stderr: '' };
      },
    });
    await b.find({ query: 'x' });
    expect(calls.flat().join(' ')).not.toContain('sess-token-123');
  });

  it('rejects dangerous ids', async () => {
    const b = new BwBackend({
      env: { BW_SESSION: 's' },
      runner: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    });
    await expect(b.meta({ backend: 'bw', id: '--help' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(FAKE.id).toBeTruthy();
  });

  it('raisePasskeyCounter changes only the counter, never lowers it, and scrubs the key from a bw echo', async () => {
    const key = randomBytes(32).toString('base64url');
    const cred = { credentialId: 'b64.AAAA', rpId: 'rp.test', keyValue: key, counter: '4' };
    const item = { id: 'pk1', name: 'n', login: { username: 'u', fido2Credentials: [cred] } };
    const edits: unknown[] = [];
    const b = new BwBackend({
      env: { BW_SESSION: 's' },
      runner: async (_bin, args, o) => {
        if (args[0] === 'get') return { code: 0, stdout: JSON.stringify(item), stderr: '' };
        edits.push(JSON.parse(Buffer.from(String(o?.input), 'base64').toString('utf8')));
        return { code: 1, stdout: '', stderr: `invalid body ${key}` };
      },
    });
    const ref = { backend: 'bw', id: 'pk1' };
    await b.raisePasskeyCounter(ref, 'b64.AAAA', 4);
    expect(edits).toHaveLength(0);
    const err = await b.raisePasskeyCounter(ref, 'b64.AAAA', 5).catch((e: Error) => e);
    expect(edits).toEqual([
      { ...item, login: { ...item.login, fido2Credentials: [{ ...cred, counter: '5' }] } },
    ]);
    expect(err).toMatchObject({ code: 'BACKEND' });
    expect(String(err)).not.toContain(key);
    await expect(b.raisePasskeyCounter(ref, 'b64.BBBB', 9)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
