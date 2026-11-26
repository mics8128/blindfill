import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** backend id, default "bw" */
  backend?: string;
  /** per-backend options, e.g. { "bw": { "bin": "/usr/local/bin/bw" } } */
  backends?: Record<string, { bin?: string; [k: string]: unknown }>;
  web?: {
    /** attach to this loopback CDP endpoint instead of the saved session (alias of endpoint) */
    cdp?: string;
    /** browser provider id: chromium-launch | chromium-cdp | firefox-connect (default: inferred) */
    browser?: string;
    /** loopback endpoint (CDP http://… or Playwright server ws://…) */
    endpoint?: string;
    /** JSON file {"endpoint": "…"} re-read on every connect */
    endpointFile?: string;
    /** alternative playwright-core whose version matches the browser server */
    playwrightModule?: string;
    headless?: boolean;
    executablePath?: string;
  };
}

export function configPath(): string {
  return process.env.BLINDFILL_CONFIG ?? join(homedir(), '.config', 'blindfill', 'config.json');
}

export function loadConfig(): Config {
  let cfg: Config = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    /* no config: defaults */
  }
  if (process.env.BLINDFILL_BACKEND) cfg.backend = process.env.BLINDFILL_BACKEND;
  return cfg;
}

/** Browser attach settings from flags > env > config. */
export function attachSettings(
  cfg: Config,
  flags: {
    endpoint?: string;
    cdp?: string;
    endpointFile?: string;
    browser?: string;
    page?: string;
    urlIncludes?: string;
  } = {},
): {
  endpoint?: string;
  endpointFile?: string;
  browser?: string;
  pageIndex?: number;
  urlIncludes?: string;
  playwrightModule?: string;
} {
  const w = cfg.web ?? {};
  const flagGiven = !!(flags.endpoint || flags.cdp || flags.endpointFile);
  const envEndpoint = process.env.BLINDFILL_ENDPOINT;
  const envFile = process.env.BLINDFILL_ENDPOINT_FILE;
  const endpoint =
    flags.endpoint ?? flags.cdp ?? (flagGiven ? undefined : (envEndpoint ?? w.endpoint ?? w.cdp));
  const endpointFile =
    flags.endpointFile ?? (flagGiven || endpoint ? undefined : (envFile ?? w.endpointFile));
  const pageIndex = flags.page !== undefined && /^\d+$/.test(flags.page) ? Number(flags.page) : undefined;
  return {
    endpoint,
    endpointFile,
    browser: flags.browser ?? process.env.BLINDFILL_BROWSER ?? w.browser,
    pageIndex,
    urlIncludes: flags.urlIncludes,
    playwrightModule: w.playwrightModule,
  };
}
