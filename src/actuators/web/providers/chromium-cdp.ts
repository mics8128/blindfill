import { chromium } from 'playwright-core';
import type { BrowserProvider } from './types.js';
import { assertLoopbackEndpoint, resolveEndpoint, selectPage } from './util.js';

/** Attach to a running Chromium over CDP (loopback only). */
export const chromiumCdp: BrowserProvider = {
  id: 'chromium-cdp',
  title: 'Attach to Chromium over CDP (loopback)',
  attachable: true,
  capabilities: { evaluateIsolatedWorld: false, cdp: true, ownsBrowser: false, pagesSurviveDisconnect: true },
  async connect(opts) {
    const endpoint = resolveEndpoint(opts);
    assertLoopbackEndpoint(endpoint);
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[opts.contextIndex ?? 0] ?? (await browser.newContext());
    const page = await selectPage(context, opts);
    return {
      page,
      context,
      browser,
      capabilities: chromiumCdp.capabilities,
      close: () => browser.close().catch(() => undefined), // CDP attach: disconnects, never kills
    };
  },
};
