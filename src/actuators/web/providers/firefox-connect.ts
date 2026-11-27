import * as bundled from 'playwright-core';
import type { Browser, BrowserType } from 'playwright-core';
import { BlindfillError } from '../../../core/types.js';
import { globalScrubber } from '../../../core/scrubber.js';
import type { BrowserProvider } from './types.js';
import { assertLoopbackEndpoint, redactEndpoint, resolveEndpoint, selectPage } from './util.js';

/**
 * Attach to a Playwright browser server (Firefox / Camoufox): `firefox.connect(wsEndpoint)`.
 *
 * Firefox has no CDP. The Playwright client must match the server's Playwright version (a mismatch
 * answers `428 Precondition Required`), and Camoufox ships a patched Juggler for an older Playwright.
 * Candidates are tried in order: options.playwrightModule, env BLINDFILL_PLAYWRIGHT_CORE, the bundled
 * playwright-core, then the optional `playwright-core-compat` package (pinned to Camoufox's version).
 */
async function candidates(opts: { playwrightModule?: string }): Promise<{ name: string; ff: BrowserType }[]> {
  const out: { name: string; ff: BrowserType }[] = [];
  const specs = [opts.playwrightModule, process.env.BLINDFILL_PLAYWRIGHT_CORE].filter(
    (x): x is string => !!x,
  );
  for (const spec of specs) {
    try {
      const m = (await import(/* @vite-ignore */ spec)) as {
        firefox?: BrowserType;
        default?: { firefox?: BrowserType };
      };
      const ff = m.firefox ?? m.default?.firefox;
      if (ff) out.push({ name: spec, ff });
    } catch {
      /* try the next one */
    }
  }
  out.push({ name: 'playwright-core (bundled)', ff: bundled.firefox });
  try {
    const compat = 'playwright-core-compat';
    const m = (await import(/* @vite-ignore */ compat)) as {
      firefox?: BrowserType;
      default?: { firefox?: BrowserType };
    };
    const ff = m.firefox ?? m.default?.firefox;
    if (ff) out.push({ name: compat, ff });
  } catch {
    /* optional package not installed */
  }
  return out;
}

/** Some Playwright clients cannot parse ws://[::1]:port; offer a localhost spelling as a second try. */
function spellings(endpoint: string): string[] {
  const alt = endpoint.replace('//[::1]', '//localhost');
  return alt === endpoint ? [endpoint] : [endpoint, alt];
}

export const firefoxConnect: BrowserProvider = {
  id: 'firefox-connect',
  title: 'Attach to a Playwright browser server (Firefox / Camoufox)',
  attachable: true,
  capabilities: { evaluateIsolatedWorld: true, cdp: false, ownsBrowser: false, pagesSurviveDisconnect: true },
  async connect(opts) {
    const endpoint = resolveEndpoint(opts);
    assertLoopbackEndpoint(endpoint);
    // shortcut: endpoint comes from options or env, not the session file; persist it there if users ask
    const marionette = opts.marionette ?? process.env.BLINDFILL_MARIONETTE;
    if (marionette) assertLoopbackEndpoint(`http://${marionette}`);
    const errors: string[] = [];
    let browser: Browser | null = null;
    for (const c of await candidates(opts)) {
      for (const ep of spellings(endpoint)) {
        try {
          browser = await c.ff.connect(ep, { timeout: 15_000 });
          break;
        } catch (e) {
          const first = String((e as Error).message ?? e).split('\n')[0];
          errors.push(`${c.name}: ${first.split(endpoint).join(redactEndpoint(endpoint))}`);
        }
      }
      if (browser) break;
    }
    if (!browser)
      throw new BlindfillError(
        'ACTUATOR',
        globalScrubber.scrub(
          `could not connect to ${redactEndpoint(endpoint)} (${errors.join('; ').slice(0, 400)}). ` +
            'A 428 usually means the Playwright client version differs from the server: set BLINDFILL_PLAYWRIGHT_CORE to a matching playwright-core (see docs/browsers.md).',
        ),
      );
    const context = browser.contexts()[opts.contextIndex ?? 0] ?? (await browser.newContext());
    const page = await selectPage(context, opts);
    const b = browser;
    return {
      page,
      context,
      browser: b,
      capabilities: firefoxConnect.capabilities,
      marionette,
      close: () => b.close().catch(() => undefined), // connected browser: disconnects, server keeps running
    };
  },
};
