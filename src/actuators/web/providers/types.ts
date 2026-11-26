import type { Browser, BrowserContext, Page } from 'playwright-core';

/**
 * Browser provider contract (see docs/browsers.md).
 *
 * A provider answers one question: "give me a Playwright Page (and its Context) for this browser".
 * Everything security-relevant (origin binding, lock, scrubbing, one-shot) lives ABOVE this layer in
 * the engine and is identical for every provider. A provider must never read page content,
 * never log endpoints that contain tokens, and must not close a browser it does not own.
 */
export interface ProviderCapabilities {
  /**
   * `page.evaluate()` runs in an isolated world: page-script globals (window.foo) are NOT visible.
   * Blindfill's own scripts never depend on page globals, so this is informational (Camoufox/Firefox: true).
   */
  evaluateIsolatedWorld: boolean;
  /** A Chrome DevTools Protocol session can be opened for this browser. */
  cdp: boolean;
  /** close() terminates the browser (true only when the provider launched it). */
  ownsBrowser: boolean;
  /** Pages survive a disconnect, so separate CLI invocations can share a page. */
  pagesSurviveDisconnect: boolean;
}

export interface ProviderOptions {
  /** ws:// or http:// loopback endpoint (connect providers). */
  endpoint?: string;
  /** Path of a JSON file `{ "endpoint": "ws://..." }`, read on every connect (the endpoint may rotate). */
  endpointFile?: string;
  /** Launch providers: browser executable (Chromium-based, e.g. Ego Lite). Env BLINDFILL_CHROMIUM also honoured. */
  executablePath?: string;
  headless?: boolean;
  /** Which context of an attached browser to use (default 0). */
  contextIndex?: number;
  /** Page selection for attached browsers. */
  pageIndex?: number;
  urlIncludes?: string;
  /** borrowed-page provider: the page the caller already holds. */
  page?: Page;
  /** Module specifier or path of an alternative playwright-core (version must match the browser server). */
  playwrightModule?: string;
}

export interface ProviderConnection {
  page: Page;
  context: BrowserContext;
  browser: Browser | null;
  capabilities: ProviderCapabilities;
  /** Release our hold: disconnect when attached, terminate when owned, nothing when borrowed. */
  close(): Promise<void>;
}

export interface BrowserProvider {
  /** Stable id used by `--browser <id>`, config `web.browser` and the registry. */
  readonly id: string;
  readonly title: string;
  /** Static, best-effort capabilities (the connection's own capabilities are authoritative). */
  readonly capabilities: ProviderCapabilities;
  /** Whether `session attach` / the saved session file make sense (false for borrowed-page). */
  readonly attachable: boolean;
  connect(opts: ProviderOptions): Promise<ProviderConnection>;
}
