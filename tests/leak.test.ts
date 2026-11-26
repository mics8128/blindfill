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
/** values blindfill generated during the run (read back from the mock vault): checked like the canary */
const generated: string[] = [];
const vault = () =>
  JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8')) as {
    id: string;
    name: string;
    login: { password: string };
    fields?: { name: string; value: string; type: number }[];
  }[];

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

const O = () => `http://good.localhost:${sites.port}`;
const loginRule = () => ({
  id: 'main',
  top_origin: O(),
  form: '#signin',
  fields: { username: '#u', password: '#p' },
  submit: { selector: '#go', kind: 'native' },
});
const regRule = () => ({
  id: 'signup',
  mode: 'registration',
  top_origin: O(),
  form: '#signup',
  fields: { username: '#login', password: '#pw1' },
  confirm_password: '#pw2',
  submit: { selector: '#create', kind: 'native' },
});
function leakRuleItem(id: string, mk: (() => object)[] | (() => object), extra: object[] = []) {
  const rs = (Array.isArray(mk) ? mk : [mk]).map((f) => f());
  return {
    id,
    type: 1,
    name: id,
    login: {
      username: CANARY_USER,
      password: CANARY,
      totp: 'JBSWY3DPEHPK3PXP',
      uris: [{ uri: `${O()}/`, match: 1 }],
    },
    fields: [
      ...extra,
      { name: 'blindfill.rules', value: JSON.stringify({ version: 2, rules: rs }), type: 0 },
    ],
  };
}

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
      leakRuleItem('leak-rule', [loginRule]),
      leakRuleItem('leak-reg', [regRule], [{ name: 'blindfill.registration', value: 'allow', type: 0 }]),
    ]),
  );
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ backend: 'bw', backends: { bw: { bin: resolve('tests/fixtures/mock-bw.mjs') } } }),
  );
  env = {
    ...process.env,
    BLINDFILL_STATE_DIR: join(dir, 'state'),
    BLINDFILL_CONFIG_DIR: join(dir, 'cfg'),
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

/** MCP server over stdio with the test env; every response is captured for the final grep. */
async function mcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...TSX, 'src/mcp.ts'],
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>,
    cwd: resolve('.'),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const client = new Client({ name: 'leak-test', version: '0' });
  await client.connect(transport);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      captured.push({ label: `mcp ${name} ${JSON.stringify(args)}`, text: JSON.stringify(r) });
      return r as { content: { text: string }[]; isError?: boolean };
    },
    close: async () => {
      await client.close();
      captured.push({ label: 'mcp stderr', text: stderr });
    },
  };
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
      'diagnose_fields',
      'discover_fields',
      'fill',
      'fill_totp',
      'human_handoff',
      'item_show',
      'list_pages',
      'probe',
      'register_credentials',
      'session_stop',
      'totp_code',
      'verify_login',
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
    const lp = await call('list_pages');
    expect(lp.isError).toBeFalsy();
    const dsc = await call('discover_fields', { item: 'leak-rule', url: good('/multi'), rule: 'main' });
    expect(dsc.content[0].text).toContain('"planned"');
    const dg = await call('diagnose_fields', { item: 'leak-rule', rule: 'main' });
    expect(dg.content[0].text).toContain('values_exposed');
    const hp = await call('human_handoff', { action: 'pause', reason: 'captcha' });
    expect(hp.content[0].text).toContain('"paused"');
    expect((await call('fill', { item: 'leak-item', url: good('/simple'), submit: true })).isError).toBe(
      true,
    );
    expect((await call('probe')).isError).toBe(true);
    expect((await call('list_pages')).isError).toBeFalsy();
    const hr = await call('human_handoff', { action: 'resume' });
    expect(hr.content[0].text).toContain('"active"');
    sites.received.length = 0;
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
    // regression: a caller-supplied guess must not be echoed (a scrubbed echo marks the right guess)
    const guess = await call('fill', { item: 'leak-item', rule: `nope ${CANARY} nope` });
    expect(guess.isError).toBe(true);
    expect(guess.content[0].text).not.toMatch(/REDACTED|WITHHELD/);
    expect(sites.received[0].fields.password).toBe(CANARY);
    expect((await call('probe')).isError).toBe(true);
    expect((await call('candidates')).isError).toBe(true);
    expect((await call('diagnose_fields', { item: 'leak-rule' })).isError).toBe(true);
    expect((await call('discover_fields', { item: 'leak-rule' })).isError).toBe(true);
    expect((await call('register_credentials', { item: 'leak-reg', rule: 'signup' })).isError).toBe(true);
    const vl = await call('verify_login', { success: '#welcome', failure: '#error' });
    expect(vl.content[0].text).toContain('identity_verified');
    expect((await call('fill_totp', { item: 'leak-item' })).isError).toBe(true);
    await call('session_stop');
    await client.close();
    captured.push({ label: 'mcp stderr', text: mcpStderr });
  }, 120_000);

  it('CLI: rules, discover/diagnose/verify, pages, profiles and registration stay free of the canary', async () => {
    expect((await cli('session', 'start', '--headless')).code).toBe(0);
    const good = (p: string) => `http://good.localhost:${sites.port}${p}`;
    sites.received.length = 0;

    const disc = await cli('page', 'discover', '--item', 'leak-rule', '--url', good('/multi'));
    expect(JSON.parse(disc.stdout)).toMatchObject({
      status: 'planned',
      rule_id: 'main',
      secrets_read: false,
    });
    const diag = await cli('page', 'diagnose', '--item', 'leak-rule', '--rule', 'main');
    expect(diag.code).toBe(0);
    expect(diag.stdout).not.toContain(CANARY_USER);
    expect(JSON.parse((await cli('page', 'list')).stdout).pages.length).toBe(1);

    const init = await cli(
      'profile',
      'init',
      'p1',
      '--item',
      'leak-rule',
      '--origin',
      O(),
      '--rule',
      'main',
      '--submit',
    );
    expect(init.code).toBe(0);
    const rev = JSON.parse(init.stdout).revision as string;
    expect((await cli('profile', 'validate', 'p1')).code).toBe(0);
    const bad = await cli('profile', 'login', 'p1', '--revision', '0'.repeat(64));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('profile_revision_mismatch');
    const chk = await cli('profile', 'login', 'p1', '--check', '--revision', rev);
    expect(JSON.parse(chk.stdout)).toMatchObject({ status: 'planned', profile: 'p1' });
    const login = await cli('profile', 'login', 'p1', '--expect-url', '/home');
    expect(JSON.parse(login.stdout)).toMatchObject({ submitted: true, outcome: 'success' });
    expect(sites.received[0].fields.a2).toBe(CANARY);
    const vf = await cli('page', 'verify', '--success-selector', '#welcome', '--fail-selector', '#error');
    expect(JSON.parse(vf.stdout)).toMatchObject({ login_outcome: 'success', identity_verified: false });
    expect((await cli('page', 'diagnose', '--item', 'leak-rule')).code).toBe(1);
    expect((await cli('session', 'stop')).code).toBe(0);

    expect((await cli('session', 'start', '--headless')).code).toBe(0);
    sites.received.length = 0;
    const reg = await cli('register', '--item', 'leak-reg', '--rule', 'signup', '--url', good('/register'));
    expect(JSON.parse(reg.stdout)).toMatchObject({
      submitted: false,
      filled: ['username', 'password', 'confirm_password'],
    });
    expect(sites.received).toHaveLength(0);
    expect((await cli('register', '--item', 'leak-reg', '--rule', 'signup', '--submit')).code).toBe(1);
    expect((await cli('session', 'stop')).code).toBe(0);
    // refused: no opt-in
    expect((await cli('session', 'start', '--headless')).code).toBe(0);
    const noopt = await cli('register', '--item', 'leak-rule', '--rule', 'main', '--url', good('/multi'));
    expect(noopt.code).toBe(1);
    await cli('session', 'stop');
  }, 180_000);

  it('CLI: item generate/admin, handoff, register with a generated password stay free of secrets', async () => {
    const good = (p: string) => `http://good.localhost:${sites.port}${p}`;
    const gen = await cli('item', 'generate', 'leak-gen', '--origin', O(), '--username', 'gen-user');
    expect(JSON.parse(gen.stdout)).toMatchObject({ password_generated: true, secret_exposed: false });
    const items = vault();
    const g = items.find((i) => i.name === 'leak-gen')!;
    generated.push(g.login.password);
    // the vault owner adds a registration rule (mock vault edit, not an agent path)
    g.fields = [
      ...(g.fields ?? []),
      { name: 'blindfill.rules', value: JSON.stringify({ version: 2, rules: [regRule()] }), type: 0 },
    ];
    writeFileSync(join(dir, 'items.json'), JSON.stringify(items));

    expect((await cli('item', 'password-policy', 'leak-item')).code).toBe(0);
    expect((await cli('item', 'list')).code).toBe(0);
    expect((await cli('item', 'status', g.id)).code).toBe(0);
    expect((await cli('item', 'status', 'leak-item')).code).toBe(0);
    expect((await cli('item', 'rename', g.id, 'leak-gen2')).code).toBe(0);
    expect((await cli('item', 'edit', g.id, '--set', 'store_id=S-1')).code).toBe(0);
    // secret edits from a non-terminal are refused, and the refused value is never echoed
    for (const kv of ['password=CANARY-pw-argv', 'pin=CANARY-pw-argv']) {
      const r = await cli('item', 'edit', 'leak-item', '--set', kv);
      expect(r.code).toBe(1);
    }
    expect((await cli('item', 'edit', 'leak-item', '--secret', 'password')).code).toBe(1);
    expect((await cli('item', 'create', '--origin', O(), '--username', 'x')).code).toBe(1);
    expect((await cli('item', 'reveal', 'leak-item')).code).toBe(1);

    expect((await cli('session', 'start', '--headless')).code).toBe(0);
    const m = await mcp(); // attached before the pause, so a cached policy would miss it
    expect((await m.call('list_pages')).isError).toBeFalsy();
    expect((await cli('handoff', 'pause', '--reason', 'captcha')).code).toBe(0);
    expect((await cli('handoff', 'status')).code).toBe(0);
    const paused = await cli('fill', '--item', 'leak-item', '--url', good('/simple'), '--submit');
    expect(paused.code).toBe(1);
    // regression: an already-running MCP server honours a pause written by the CLI
    const mp = await m.call('probe');
    expect(mp.isError).toBe(true);
    expect(mp.content[0].text).toContain('paused');
    await m.close();
    expect((await cli('handoff', 'resume')).code).toBe(0);

    sites.received.length = 0;
    const reg = await cli(
      'register',
      '--item',
      g.id,
      '--rule',
      'signup',
      '--url',
      good('/register'),
      '--submit',
    );
    expect(JSON.parse(reg.stdout)).toMatchObject({ submitted: true });
    await expect.poll(() => sites.received.length, { timeout: 5000 }).toBe(1);
    expect(sites.received[0].fields.password).toBe(generated[0]); // the page did get it
    expect((await cli('page', 'verify', '--success-selector', '#welcome')).code).toBe(0);
    expect((await cli('probe')).code).toBe(1);
    await cli('session', 'stop');
  }, 180_000);

  it('grep: zero occurrences in all captured output and all state files', () => {
    const hits: string[] = [];
    const ns = [CANARY, ...generated].flatMap(needles);
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
    for (const f of filesUnder(join(dir, 'cfg'))) check(f, readFileSync(f, 'utf8'));
    expect(hits).toEqual([]);
    const audit = readFileSync(join(dir, 'state', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"fill"');
    expect(audit).toContain('"event":"refused"');
  });
});
