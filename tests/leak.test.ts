import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARY, CANARY_USER, startSites } from './helpers/sites.js';

/**
 * LEAK TEST. Runs real fills (CLI and MCP, separate processes) with a canary password and greps every
 * stdout/stderr, every MCP response, and every file blindfill wrote (audit log, session state, notices)
 * for the canary in raw, URL-encoded, form-encoded, JSON-escaped, base64 (all alignments), base64url and hex form.
 */
function needles(s: string): string[] {
  const out = new Set<string>([
    s,
    encodeURIComponent(s),
    encodeURIComponent(s).replace(/%20/g, '+'),
    JSON.stringify(s).slice(1, -1),
    Buffer.from(s).toString('hex'),
    Buffer.from(s).toString('hex').toUpperCase(),
    'CANARY-pw', // the recognisable prefix
  ]);
  for (let pad = 0; pad < 3; pad++) {
    const b = Buffer.from('x'.repeat(pad) + s);
    out.add(b.toString('base64').slice(4, -4));
    out.add(b.toString('base64url').slice(4, -4));
  }
  return [...out];
}

const TSX = ['--import', 'tsx'];
let dir: string;
let sites: Awaited<ReturnType<typeof startSites>>;
let env: NodeJS.ProcessEnv;
const captured: { label: string; text: string }[] = [];

function run(entry: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn(process.execPath, [...TSX, entry, ...args], { env, cwd: resolve('.') });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => {
      captured.push(
        { label: `${entry} ${args.join(' ')} [stdout]`, text: stdout },
        { label: `${entry} ${args.join(' ')} [stderr]`, text: stderr },
      );
      res({ code: code ?? 1, stdout, stderr });
    });
  });
}
const cli = (...a: string[]) => run('src/cli.ts', a);

beforeAll(async () => {
  sites = await startSites();
  dir = mkdtempSync(join(tmpdir(), 'bf-leak-'));
  const good = `http://good.localhost:${sites.port}/`;
  writeFileSync(
    join(dir, 'items.json'),
    JSON.stringify([
      {
        id: 'leak-item',
        type: 1,
        name: 'Leak Item',
        notes: 'CANARY-notes-secret',
        login: {
          username: CANARY_USER,
          password: CANARY,
          totp: 'JBSWY3DPEHPK3PXP',
          uris: [{ uri: good, match: 1 }],
        },
        fields: [{ name: 'pin', value: 'CANARY-pin-123456', type: 1 }],
      },
    ]),
  );
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ backend: 'bw', backends: { bw: { bin: resolve('tests/fixtures/mock-bw.mjs') } } }),
  );
  env = {
    ...process.env,
    BLINDFILL_STATE_DIR: join(dir, 'state'),
    BLINDFILL_CONFIG: join(dir, 'config.json'),
    BLINDFILL_MOCK_BW_ITEMS: join(dir, 'items.json'),
    BW_SESSION: 'mock-session-token',
    BLINDFILL_NO_SANDBOX: '1',
    DEBUG: 'pw:api,pw:browser*',
  };
  delete env.BLINDFILL_AUDIT_FILE;
});
afterAll(async () => {
  await cli('session', 'stop');
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});

function filesUnder(d: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('leak test: canary password never appears anywhere', () => {
  it('CLI: login flow, lock, errors, refusals', async () => {
    const start = await cli('session', 'start', '--headless');
    expect(start.code).toBe(0);
    const good = (p: string) => `http://good.localhost:${sites.port}${p}`;

    const show = await cli('item', 'show', '--item', 'leak-item');
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({
      username: CANARY_USER,
      secretFields: ['password', 'pin'],
    });

    const totp = await cli('totp', '--item', 'leak-item');
    expect(JSON.parse(totp.stdout).code).toMatch(/^\d{6}$/);

    const probe0 = await cli('probe', '--url', good('/simple')); // regression: probe honours --url on a blank page
    expect(probe0.code).toBe(0);
    expect(JSON.parse(probe0.stdout).origin).toBe(`http://good.localhost:${sites.port}`);

    const refused = await cli(
      'fill',
      '--item',
      'leak-item',
      '--url',
      `http://evil.localhost:${sites.port}/simple`,
      '--submit',
    );
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('ORIGIN_MISMATCH');
    expect(sites.received).toHaveLength(0);

    const fill = await cli(
      'fill',
      '--item',
      'leak-item',
      '--url',
      good('/simple'),
      '--submit',
      '--expect-url',
      '/home',
      '--fail-selector',
      '#error',
    );
    expect(fill.code).toBe(0);
    expect(JSON.parse(fill.stdout)).toMatchObject({
      outcome: 'success',
      locked: true,
      filled: ['username', 'password'],
    });
    expect(sites.received[0].fields.password).toBe(CANARY); // the page did get it

    const probe = await cli('probe');
    expect(probe.code).toBe(1);
    expect(probe.stdout).toContain('SESSION_LOCKED');
    const again = await cli('fill', '--item', 'leak-item', '--url', good('/simple'), '--submit');
    expect(again.code).toBe(1);
    expect(again.stdout).toMatch(/POLICY|SESSION_LOCKED/);
    const status = JSON.parse((await cli('session', 'status')).stdout);
    expect(status.locked).toBe(true);
    const stop = await cli('session', 'stop');
    expect(stop.code).toBe(0);
  }, 120_000);

  it('MCP: every tool response and error is free of the canary; descriptions state the contract', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...TSX, 'src/mcp.ts'],
      env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
      cwd: resolve('.'),
      stderr: 'pipe',
    });
    let mcpStderr = '';
    transport.stderr?.on('data', (d) => (mcpStderr += d));
    const client = new Client({ name: 'leak-test', version: '0' });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'candidates',
      'fill',
      'fill_totp',
      'item_show',
      'probe',
      'session_stop',
      'totp_code',
    ]);
    for (const t of tools.tools) {
      expect(t.description).toMatch(/never returned|write-only/);
      captured.push({ label: `mcp tool ${t.name} description`, text: JSON.stringify(t) });
    }
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = JSON.stringify(r);
      captured.push({ label: `mcp ${name} ${JSON.stringify(args)}`, text });
      return r as { content: { text: string }[]; isError?: boolean };
    };
    const good = (p: string) => `http://good.localhost:${sites.port}${p}`;

    sites.received.length = 0;
    const s = await call('item_show', { item: 'leak-item' });
    expect(s.content[0].text).toContain('"pin"');
    await call('totp_code', { item: 'leak-item' });
    const bad = await call('fill', {
      item: 'leak-item',
      url: `http://evil.localhost:${sites.port}/simple`,
      submit: true,
    });
    expect(bad.isError).toBe(true);
    const ok = await call('fill', {
      item: 'leak-item',
      url: good('/simple'),
      submit: true,
      expect: { urlIncludes: '/home' },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('"outcome": "success"');
    expect(sites.received[0].fields.password).toBe(CANARY);
    expect((await call('probe')).isError).toBe(true);
    expect((await call('candidates')).isError).toBe(true);
    expect((await call('fill_totp', { item: 'leak-item' })).isError).toBe(true);
    await call('session_stop');
    await client.close();
    captured.push({ label: 'mcp stderr', text: mcpStderr });
  }, 120_000);

  it('grep: zero occurrences in all captured output and all state files', () => {
    const hits: string[] = [];
    const ns = needles(CANARY);
    const check = (label: string, text: string) => {
      for (const n of ns) if (text.includes(n)) hits.push(`${label} contains ${n.slice(0, 12)}…`);
      if (text.includes('JBSWY3DPEHPK3PXP')) hits.push(`${label} contains the TOTP seed`);
      if (text.includes('CANARY-pin') || text.includes('CANARY-notes'))
        hits.push(`${label} contains a hidden field / notes`);
    };
    expect(captured.length).toBeGreaterThan(20);
    for (const c of captured) check(c.label, c.text);
    const stateFiles = filesUnder(join(dir, 'state'));
    expect(stateFiles.some((f) => f.endsWith('audit.jsonl'))).toBe(true);
    for (const f of stateFiles) check(f, readFileSync(f, 'utf8'));
    expect(hits).toEqual([]);
    const audit = readFileSync(join(dir, 'state', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"fill"');
    expect(audit).toContain('"event":"refused"');
  });
});
