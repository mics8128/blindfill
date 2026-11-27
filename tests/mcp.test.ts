import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/mcp.js';

const ARG = 'CANARY-arg-9f3Q';

describe('MCP error surface', () => {
  it('schema errors and unknown tools: one fixed code, no message, no argument echoed', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    const client = new Client({ name: 'mcp-test', version: '0' });
    await client.connect(clientSide);
    const calls: [string, Record<string, unknown>][] = [
      ['fill', { item: 987654321, url: ARG }],
      ['fill', { fields: ARG }],
      ['human_handoff', { action: ARG }],
      ['candidates', { role: ARG }],
      ['verify_login', { success: 42, failure: ARG }],
      [ARG, {}],
    ];
    for (const [name, args] of calls) {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text)).toEqual({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(JSON.stringify(r)).not.toContain(ARG);
      expect(JSON.stringify(r)).not.toContain('987654321');
    }
    await client.close();
  });
});
