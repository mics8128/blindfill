import { chromium } from 'playwright-core';
import type { BrowserProvider } from './types.js';

/** Playwright-launched Chromium (bundled, or any Chromium-based executable, e.g. Ego Lite). Empty profile. */
export const chromiumLaunch: BrowserProvider = {
  id: 'chromium-launch',
  title: 'Launch Chromium (bundled or custom executable)',
  attachable: false,
  capabilities: { evaluateIsolatedWorld: false, cdp: true, ownsBrowser: true, pagesSurviveDisconnect: false },
  async connect(opts) {
    const browser = await chromium.launch({
      headless: opts.headless ?? true,
      executablePath: opts.executablePath ?? process.env.BLINDFILL_CHROMIUM ?? undefined,
      args: process.env.BLINDFILL_NO_SANDBOX === '1' ? ['--no-sandbox'] : undefined,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      page,
      context,
      browser,
      capabilities: chromiumLaunch.capabilities,
      close: () => browser.close().catch(() => undefined),
    };
  },
};
