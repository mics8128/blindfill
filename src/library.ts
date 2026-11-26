import type { Page } from 'playwright-core';
import { WebActuator } from './actuators/web/web.js';
import type { Backend } from './backends/spi.js';
import { createBackend } from './backends/registry.js';
import { loadConfig, type Config } from './config.js';
import { SessionPolicy } from './core/policy.js';
import { Engine } from './engine.js';

export interface WithPageOptions {
  /** vault backend; default: created from the blindfill config */
  backend?: Backend;
  config?: Config;
  /** reuse a policy to keep the post-fill lock / one-shot state across several withPage calls */
  policy?: SessionPolicy;
}

/**
 * Library entry for owners that already hold a Playwright Page (any browser, incl. Firefox/Camoufox).
 * The page is borrowed: blindfill never navigates away on its own, never closes it, and the engine
 * enforces the same binding, lock, one-shot and scrubbing rules as the CLI/MCP.
 *
 *   await withPage(page, { backend }, (bf) => bf.fill({ item: 'abc', submit: true }));
 */
export async function withPage<T>(
  page: Page,
  opts: WithPageOptions,
  fn: (engine: Engine) => Promise<T>,
): Promise<T> {
  const backend =
    opts.backend ?? createBackend((opts.config ?? loadConfig()).backend ?? 'bw', opts.config ?? loadConfig());
  const engine = new Engine(backend, WebActuator.fromPage(page, opts.policy));
  return fn(engine);
}
