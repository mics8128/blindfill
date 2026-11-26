import { BlindfillError } from '../../../core/types.js';
import type { BrowserProvider } from './types.js';
import { borrowedPage } from './borrowed-page.js';
import { chromiumCdp } from './chromium-cdp.js';
import { chromiumLaunch } from './chromium-launch.js';
import { firefoxConnect } from './firefox-connect.js';
import { egoCli } from './ego-cli.js';

const providers = new Map<string, BrowserProvider>();

export function registerProvider(p: BrowserProvider): void {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(p.id)) throw new Error(`invalid provider id "${p.id}"`);
  providers.set(p.id, p);
}
export function getProvider(id: string): BrowserProvider {
  const p = providers.get(id);
  if (!p)
    throw new BlindfillError(
      'UNSUPPORTED',
      `unknown browser provider "${id}" (available: ${[...providers.keys()].join(', ')})`,
    );
  return p;
}
export function listProviders(): BrowserProvider[] {
  return [...providers.values()];
}

/**
 * Guess the provider for an attach endpoint when --browser is absent:
 * http(s) or a ws path containing /devtools/ => CDP; any other ws endpoint => Playwright server (Firefox).
 */
export function inferProviderId(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    if (u.protocol === 'ego:') return 'ego-cli';
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.pathname.startsWith('/devtools/'))
      return 'chromium-cdp';
    return 'firefox-connect';
  } catch {
    return 'chromium-cdp';
  }
}

for (const p of [chromiumLaunch, chromiumCdp, firefoxConnect, borrowedPage, egoCli]) registerProvider(p);
