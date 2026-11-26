import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { withPage } from '../src/library.js';
import { globalScrubber } from '../src/core/scrubber.js';
import { firefoxTestsEnabled, startCamoufoxServer, type FirefoxServer } from './helpers/firefox.js';
import { CANARY, CANARY_USER, startSites } from './helpers/sites.js';

/**
 * OPT-IN: BLINDFILL_TEST_FIREFOX=1. Needs a local Camoufox install (python launch_server); skipped otherwise.
 * Runs against a self-launched, isolated, headless Camoufox with a temp profile.
 */
const enabled = firefoxTestsEnabled();
const MOCK = resolve('tests/fixtures/mock-bw.mjs');
let ff: FirefoxServer;
let sites: Awaited<ReturnType<typeof startSites>>;
let dir: string;
let env: NodeJS.ProcessEnv;

const item = (id: string, uris: string[]) => ({
  id,
  type: 1,
  name: `Fake ${id}`,
  login: {
    username: CANARY_USER,
    password: CANARY,
    totp: 'JBSWY3DPEHPK3PXP',
    uris: uris.map((uri) => ({ uri, match: 1 })),
  },
});

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env, cwd: resolve('.') });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

describe.skipIf(!enabled)('Firefox / Camoufox (opt-in: BLINDFILL_TEST_FIREFOX=1)', () => {
  beforeAll(async () => {
    ff = await startCamoufoxServer();
    sites = await startSites();
    dir = mkdtempSync(join(tmpdir(), 'bf-fftest-'));
    const good = `http://good.localhost:${sites.port}/`;
    writeFileSync(join(dir, 'items.json'), JSON.stringify([item('good', [good])]));
    writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ endpoint: ff.endpoint }));
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ backend: 'bw', backends: { bw: { bin: MOCK } } }),
    );
    process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
    process.env.BLINDFILL_MOCK_BW_ITEMS = join(dir, 'items.json');
    env = {
      ...process.env,
      BLINDFILL_STATE_DIR: join(dir, 'state'),
      BLINDFILL_CONFIG: join(dir, 'config.json'),
      BLINDFILL_MOCK_BW_ITEMS: join(dir, 'items.json'),
      BW_SESSION: 'mock-session-token',
    };
    console.log(`[firefox tests] browser: ${ff.kind}`);
  }, 90_000);
  afterAll(async () => {
    await cli('session', 'stop');
    await ff?.stop();
    await sites?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    sites.received.length = 0;
    globalScrubber.register(CANARY);
  });

  const backend = () =>
    new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
  const good = (p: string) => sites.url('good.localhost', p);

  it('firefox-connect provider: connects (client-version fallback), isolated evaluate world, redacted endpoint', async () => {
    const act = await WebActuator.fromProvider('firefox-connect', { endpoint: ff.endpoint });
    try {
      expect(act.capabilities).toMatchObject({ evaluateIsolatedWorld: true, cdp: false, ownsBrowser: false });
      await act.navigate(good('/simple'));
      await act.page.evaluate(() => ((window as unknown as { foo: number }).foo = 1));
      // Camoufox: the evaluate world is isolated from page scripts; our heuristics must not depend on it
      const visible = await act.page.evaluate(() => typeof (window as unknown as { foo?: number }).foo);
      expect(['number', 'undefined']).toContain(visible);
      const probe = await act.probe();
      expect(probe.origin).toBe(`http://good.localhost:${sites.port}`);
      expect(probe.candidates.some((c) => c.guess?.role === 'password' && c.usable)).toBe(true);
    } finally {
      await act.close();
    }
  });

  it('fill + submit once, outcome by URL evidence, then the post-fill lock', async () => {
    const act = await WebActuator.fromProvider('firefox-connect', { endpoint: ff.endpoint });
    try {
      const eng = new Engine(backend(), act);
      const r = await eng.fill({
        item: 'good',
        url: good('/simple'),
        submit: true,
        expect: { urlIncludes: '/home', failSelector: '#error' },
      });
      expect(r).toMatchObject({
        filled: ['username', 'password'],
        submitted: true,
        outcome: 'success',
        locked: true,
      });
      expect(sites.received).toHaveLength(1);
      expect(sites.received[0].fields.password).toBe(CANARY);
      expect(JSON.stringify(r)).not.toContain('CANARY-pw');
      await expect(eng.probe()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    } finally {
      await act.close();
    }
  });

  it('refuses a lookalike origin before any secret is read (Firefox)', async () => {
    const act = await WebActuator.fromProvider('firefox-connect', { endpoint: ff.endpoint });
    try {
      const eng = new Engine(backend(), act);
      await expect(
        eng.fill({ item: 'good', url: sites.url('evil.localhost', '/simple'), submit: true }),
      ).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
      expect(sites.received).toHaveLength(0);
    } finally {
      await act.close();
    }
  });

  it('honeypot and SPA-rendered forms work in Firefox', async () => {
    for (const path of ['/honeypot', '/spa']) {
      const act = await WebActuator.fromProvider('firefox-connect', { endpoint: ff.endpoint });
      try {
        sites.received.length = 0;
        const r = await new Engine(backend(), act).fill({ item: 'good', url: good(path), submit: true });
        expect(r.filled).toEqual(['username', 'password']);
        expect(sites.received[0].fields.password).toBe(CANARY);
        expect(sites.received[0].fields.login_password ?? '').toBe('');
        expect(sites.received[0].fields.website_email ?? '').toBe('');
      } finally {
        await act.close();
      }
    }
  });

  it('library API withPage(page): borrowed Firefox page, never closed', async () => {
    const act = await WebActuator.fromProvider('firefox-connect', { endpoint: ff.endpoint });
    try {
      await act.navigate(good('/simple'));
      const r = await withPage(act.page, { backend: backend() }, (bf) =>
        bf.fill({ item: 'good', submit: false }),
      );
      expect(r.filled).toEqual(['username', 'password']);
      expect(act.page.isClosed()).toBe(false);
    } finally {
      await act.close();
    }
  });

  it('CLI: session attach --endpoint-file (JSON {endpoint}), status redacts the token, fill --url', async () => {
    const att = await cli(
      'session',
      'attach',
      '--endpoint-file',
      join(dir, 'endpoint.json'),
      '--browser',
      'firefox-connect',
    );
    expect(att.code).toBe(0);
    const a = JSON.parse(att.stdout);
    expect(a).toMatchObject({ attached: true, browser: 'firefox-connect' });
    const token = new URL(ff.endpoint).pathname.slice(1);
    expect(att.stdout + att.stderr).not.toContain(token);
    const st = await cli('session', 'status');
    expect(JSON.parse(st.stdout)).toMatchObject({ running: true, browser: 'firefox-connect' });
    expect(st.stdout).not.toContain(token);
    const f = await cli(
      'fill',
      '--item',
      'good',
      '--url',
      good('/simple'),
      '--submit',
      '--expect-url',
      '/home',
    );
    expect(f.code).toBe(0);
    expect(JSON.parse(f.stdout)).toMatchObject({ submitted: true, outcome: 'success', locked: true });
    expect(f.stdout + f.stderr).not.toContain('CANARY-pw');
    expect(readFileSync(join(dir, 'state', 'session.json'), 'utf8')).not.toContain('CANARY');
    const p = await cli('probe');
    expect(p.code).toBe(1);
    expect(p.stdout).toContain('SESSION_LOCKED');
    await cli('session', 'stop');
  });
});
