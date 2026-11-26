import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright-core';
import { BlindfillError } from '../../../core/types.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Only loopback endpoints: an attached browser can read everything, so it must be local. */
export function assertLoopbackEndpoint(endpoint: string): void {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new BlindfillError('ACTUATOR', 'invalid browser endpoint');
  }
  if (!['http:', 'ws:'].includes(u.protocol) || !LOOPBACK.has(u.hostname))
    throw new BlindfillError(
      'ACTUATOR',
      'browser endpoint must be a loopback address (127.0.0.1, localhost, ::1) over http:// or ws://',
    );
}

/** Endpoint paths of Playwright servers carry a capability token: never print them. */
export function redactEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? '/[redacted]' : ''}`;
  } catch {
    return '[invalid endpoint]';
  }
}

/** endpoint from options, or from the JSON file `{ "endpoint": "..." }` (re-read on every call). */
export function resolveEndpoint(opts: { endpoint?: string; endpointFile?: string }): string {
  if (opts.endpoint) return opts.endpoint;
  if (opts.endpointFile) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(opts.endpointFile, 'utf8'));
    } catch {
      throw new BlindfillError('ACTUATOR', 'endpoint file is missing or not valid JSON');
    }
    const ep = (doc as { endpoint?: unknown })?.endpoint;
    if (typeof ep !== 'string' || !ep)
      throw new BlindfillError(
        'ACTUATOR',
        'endpoint file must be JSON like {"endpoint":"ws://127.0.0.1:PORT/TOKEN"}',
      );
    return ep;
  }
  throw new BlindfillError('ACTUATOR', 'no browser endpoint (pass --endpoint or --endpoint-file)');
}

export async function selectPage(
  ctx: BrowserContext,
  opts: { pageIndex?: number; urlIncludes?: string },
): Promise<Page> {
  let pages = ctx.pages();
  if (pages.length === 0) pages = [await ctx.newPage()];
  let page: Page | undefined;
  if (opts.pageIndex !== undefined) page = pages[opts.pageIndex];
  else if (opts.urlIncludes) page = pages.find((p) => p.url().includes(opts.urlIncludes!));
  else page = [...pages].reverse().find((p) => /^https?:/.test(p.url())) ?? pages[pages.length - 1];
  if (!page) throw new BlindfillError('ACTUATOR', 'no matching page in the attached browser');
  return page;
}
