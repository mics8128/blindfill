import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** backend id, default "bw" */
  backend?: string;
  /** per-backend options, e.g. { "bw": { "bin": "/usr/local/bin/bw" } } */
  backends?: Record<string, { bin?: string; [k: string]: unknown }>;
  web?: {
    /** attach to this loopback CDP endpoint instead of the saved session */
    cdp?: string;
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
