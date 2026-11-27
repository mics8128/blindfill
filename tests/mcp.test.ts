import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/mcp.js';
import { createProfile } from '../src/profiles.js';
import { CANARY, CANARY_USER, startSites } from './helpers/sites.js';

const ARG = 'CANARY-arg-9f3Q';
type ToolReply = { content: { text: string }[]; isError?: boolean };

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: 'mcp-test', version: '0' });
  await client.connect(clientSide);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolReply,
  };
}

describe('MCP error surface', () => {
  it('schema errors and unknown tools: one fixed code, no message, no argument echoed', async () => {
    const { client, call } = await connect();
    const calls: [string, Record<string, unknown>][] = [
      ['fill', { item: 987654321, url: ARG }],
      ['fill', { fields: ARG }],
      ['human_handoff', { action: ARG }],
      ['candidates', { role: ARG }],
      ['verify_login', { success: 42, failure: ARG }],
      ['profile_login', { name: ARG, page: ARG }],
      ['list_credentials', { query: 987654321 }],
      [ARG, {}],
    ];
    for (const [name, args] of calls) {
      const r = await call(name, args);
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(JSON.stringify(r)).not.toContain(ARG);
      expect(JSON.stringify(r)).not.toContain('987654321');
    }
    await client.close();
  });
});

describe('MCP list_credentials and profile_login (mock vault, local fake site)', () => {
  const HIDDEN = 'CANARY-hidden-5521';
  const NOTES = 'CANARY-notes-7781';
  const SEED = 'JBSWY3DPEHPK3PXP';
  let dir: string;
  let sites: Awaited<ReturnType<typeof startSites>>;
  const saved = { ...process.env };
  const origin = () => `http://good.localhost:${sites.port}`;

  beforeAll(async () => {
    sites = await startSites();
    dir = mkdtempSync(join(tmpdir(), 'bf-mcp-'));
    const rule = {
      id: 'main',
      top_origin: origin(),
      form: '#signin',
      fields: { username: '#u', password: '#p' },
      submit: { selector: '#go', kind: 'native' },
    };
    writeFileSync(
      join(dir, 'items.json'),
      JSON.stringify([
        {
          id: 'mcp-rule',
          type: 1,
          name: 'MCP Rule',
          notes: NOTES,
          login: {
            username: CANARY_USER,
            password: CANARY,
            totp: SEED,
            uris: [{ uri: `${origin()}/`, match: 1 }],
          },
          fields: [
            { name: 'pin', value: HIDDEN, type: 1 },
            { name: 'blindfill.rules', value: JSON.stringify({ version: 2, rules: [rule] }), type: 0 },
          ],
        },
      ]),
    );
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ backend: 'bw', backends: { bw: { bin: resolve('tests/fixtures/mock-bw.mjs') } } }),
    );
    Object.assign(process.env, {
      BLINDFILL_STATE_DIR: join(dir, 'state'),
      BLINDFILL_CONFIG_DIR: join(dir, 'cfg'),
      BLINDFILL_CONFIG: join(dir, 'config.json'),
      BLINDFILL_AUDIT_FILE: join(dir, 'audit.jsonl'),
      BLINDFILL_MOCK_BW_ITEMS: join(dir, 'items.json'),
      BW_SESSION: 'mock-session-token',
      BLINDFILL_NO_SANDBOX: '1',
    });
    // a person-made recipe whose own setting would submit: MCP must still default to no submit
    createProfile('p1', {
      version: 1,
      item: 'mcp-rule',
      item_name: 'MCP Rule',
      web: { origin: origin(), rule: 'main', submit: true },
    });
  });
  afterAll(async () => {
    process.env = saved;
    await sites?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('list_credentials: names, origins and field names only; profile_login fills without submitting', async () => {
    const { client, call } = await connect();
    const secrets = [CANARY, HIDDEN, NOTES, SEED, CANARY_USER];
    try {
      const list = await call('list_credentials');
      expect(list.isError).toBeFalsy();
      expect(JSON.parse(list.content[0].text)).toEqual({
        status: 'completed',
        items: [
          {
            id: 'mcp-rule',
            name: 'MCP Rule',
            origins: [`${origin()}/`],
            fields: ['username', 'totp', 'password', 'pin'],
            rules: 1,
          },
        ],
        truncated: false,
      });
      for (const s of secrets) expect(list.content[0].text).not.toContain(s);
      const none = await call('list_credentials', { query: 'no-such-item' });
      expect(JSON.parse(none.content[0].text).items).toEqual([]);

      for (const name of ['CANARY-profile-x1', 'CANARY bad/../name']) {
        const r = await call('profile_login', { name });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).not.toContain('CANARY');
      }
      const stale = await call('profile_login', { name: 'p1', revision: '0'.repeat(64) });
      expect(stale.content[0].text).toContain('profile_revision_mismatch');

      expect((await call('probe', { url: `${origin()}/multi` })).isError).toBeFalsy();
      const login = await call('profile_login', { name: 'p1' });
      expect(login.isError).toBeFalsy();
      expect(JSON.parse(login.content[0].text)).toMatchObject({
        filled: ['username', 'password'],
        submitted: false,
        locked: true,
        profile: 'p1',
      });
      expect(sites.received).toHaveLength(0);
      for (const s of [CANARY, HIDDEN, NOTES, SEED]) expect(login.content[0].text).not.toContain(s);

      // vault metadata stays listable after the lock (as item_show); page reads do not
      expect((await call('list_credentials')).isError).toBeFalsy();
      expect((await call('probe')).isError).toBe(true);
    } finally {
      await call('session_stop');
      await client.close();
    }
  }, 120_000);
});
