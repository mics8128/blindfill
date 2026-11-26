import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getProvider,
  inferProviderId,
  listProviders,
  registerProvider,
  type BrowserProvider,
} from '../src/actuators/web/providers/index.js';
import {
  assertLoopbackEndpoint,
  redactEndpoint,
  resolveEndpoint,
} from '../src/actuators/web/providers/util.js';
import { attachSettings } from '../src/config.js';
import { WebActuator } from '../src/actuators/web/web.js';

describe('browser providers', () => {
  it('registers the four built-in providers with documented capabilities', () => {
    expect(listProviders().map((p) => p.id)).toEqual(
      expect.arrayContaining(['chromium-launch', 'chromium-cdp', 'firefox-connect', 'borrowed-page']),
    );
    expect(getProvider('firefox-connect').capabilities).toMatchObject({
      evaluateIsolatedWorld: true,
      cdp: false,
      ownsBrowser: false,
    });
    expect(getProvider('chromium-launch').capabilities.ownsBrowser).toBe(true);
    expect(() => getProvider('nope')).toThrow(/unknown browser provider/);
  });

  it('a custom provider can be registered and used through WebActuator.fromProvider', async () => {
    const fakePage = { url: () => 'http://x.localhost/', context: () => ({}) } as never;
    const p: BrowserProvider = {
      id: 'test-fake',
      title: 'fake',
      attachable: false,
      capabilities: {
        evaluateIsolatedWorld: true,
        cdp: false,
        ownsBrowser: false,
        pagesSurviveDisconnect: true,
      },
      connect: async () => ({
        page: fakePage,
        context: {} as never,
        browser: null,
        capabilities: p.capabilities,
        close: async () => undefined,
      }),
    };
    registerProvider(p);
    const act = await WebActuator.fromProvider('test-fake');
    expect(act.providerId).toBe('test-fake');
    expect(act.capabilities.evaluateIsolatedWorld).toBe(true);
    expect(() => registerProvider({ ...p, id: 'Bad Id' })).toThrow();
  });

  it('infers the provider from the endpoint', () => {
    expect(inferProviderId('http://127.0.0.1:9222')).toBe('chromium-cdp');
    expect(inferProviderId('ws://127.0.0.1:9222/devtools/browser/abc')).toBe('chromium-cdp');
    expect(inferProviderId('ws://127.0.0.1:41000/0123456789abcdef')).toBe('firefox-connect');
  });

  it('endpoint rules: loopback only, token redacted, JSON file re-read', () => {
    expect(() => assertLoopbackEndpoint('ws://10.0.0.5:1/x')).toThrow(/loopback/);
    expect(() => assertLoopbackEndpoint('wss://127.0.0.1:1/x')).toThrow(/loopback/);
    expect(() => assertLoopbackEndpoint('ws://[::1]:4000/tok')).not.toThrow();
    expect(redactEndpoint('ws://127.0.0.1:41000/SECRET-TOKEN')).toBe('ws://127.0.0.1:41000/[redacted]');
    const d = mkdtempSync(join(tmpdir(), 'bf-ep-'));
    try {
      const f = join(d, 'e.json');
      writeFileSync(f, JSON.stringify({ endpoint: 'ws://127.0.0.1:1/a' }));
      expect(resolveEndpoint({ endpointFile: f })).toBe('ws://127.0.0.1:1/a');
      writeFileSync(f, JSON.stringify({ endpoint: 'ws://127.0.0.1:2/b' }));
      expect(resolveEndpoint({ endpointFile: f })).toBe('ws://127.0.0.1:2/b');
      writeFileSync(f, '{"nope":1}');
      expect(() => resolveEndpoint({ endpointFile: f })).toThrow(/endpoint file/);
      expect(() => resolveEndpoint({ endpointFile: join(d, 'missing.json') })).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('attachSettings precedence: flags > env > config', () => {
    const cfg = { web: { endpoint: 'ws://127.0.0.1:3/c', browser: 'firefox-connect' } };
    expect(attachSettings(cfg).endpoint).toBe('ws://127.0.0.1:3/c');
    expect(attachSettings(cfg, { endpointFile: '/x.json' })).toMatchObject({
      endpoint: undefined,
      endpointFile: '/x.json',
      browser: 'firefox-connect',
    });
    expect(
      attachSettings(cfg, { endpoint: 'http://127.0.0.1:9', browser: 'chromium-cdp', page: '2' }),
    ).toMatchObject({
      endpoint: 'http://127.0.0.1:9',
      browser: 'chromium-cdp',
      pageIndex: 2,
    });
  });
});
