import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { stateDir } from '../../core/audit.js';
import { SessionPolicy } from '../../core/policy.js';
import { BlindfillError } from '../../core/types.js';
import { WebActuator } from './web.js';
import { getProvider, inferProviderId } from './providers/registry.js';
import { assertLoopbackEndpoint, redactEndpoint, resolveEndpoint } from './providers/util.js';

export interface SessionFile {
  /** Chromium CDP endpoint, or (for attached non-CDP browsers) the same endpoint string. Never printed raw. */
  cdp: string;
  /** provider id, default chromium-cdp (sessions written by older versions have none) */
  browser?: string;
  /** alternative to `cdp`: re-read from this JSON file on every connect */
  endpointFile?: string;
  playwrightModule?: string;
  /** visible browser (known only for sessions blindfill started) */
  headless?: boolean;
  owned: boolean;
  pid?: number;
  userDataDir?: string;
  policy: { locked: boolean; filled: string[] };
}

const file = () => join(stateDir(), 'session.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadSession(): SessionFile | null {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as SessionFile;
  } catch {
    return null;
  }
}
export function saveSession(s: SessionFile): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(s), { mode: 0o600 });
}

/** Start a persistent Chromium (Playwright's bundled one) with a loopback-only debugging port. */
export async function startSession(
  opts: { headless?: boolean; executablePath?: string } = {},
): Promise<SessionFile> {
  const existing = loadSession();
  if (existing?.owned && existing.pid && alive(existing.pid))
    throw new BlindfillError('POLICY', 'a session is already running; run `blindfill session stop` first');
  const exe = opts.executablePath ?? process.env.BLINDFILL_CHROMIUM ?? chromium.executablePath();
  if (!existsSync(exe))
    throw new BlindfillError('ACTUATOR', 'Chromium not found. Run: npx playwright-core install chromium');
  const dir = mkdtempSync(join(tmpdir(), 'blindfill-profile-'));
  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    ...((opts.headless ?? true) ? ['--headless=new'] : []),
    ...(process.env.BLINDFILL_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(150);
    try {
      port = Number(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch {
      /* not yet */
    }
  }
  if (!port) {
    try {
      process.kill(child.pid!, 'SIGKILL');
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
    throw new BlindfillError('ACTUATOR', 'Chromium did not expose a debugging port');
  }
  const s: SessionFile = {
    cdp: `http://127.0.0.1:${port}`,
    owned: true,
    pid: child.pid,
    userDataDir: dir,
    browser: 'chromium-cdp',
    headless: opts.headless ?? true,
    policy: { locked: false, filled: [] },
  };
  saveSession(s);
  return s;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface AttachOpts {
  /** loopback endpoint (CDP http://… or Playwright server ws://…) */
  endpoint?: string;
  /** deprecated alias of endpoint (kept for the old --cdp flag) */
  cdp?: string;
  /** JSON file {"endpoint": "..."} re-read on every connect */
  endpointFile?: string;
  browser?: string;
  urlIncludes?: string;
  pageIndex?: number;
  playwrightModule?: string;
}

function explicitSession(opts: AttachOpts): SessionFile | null {
  const endpoint = opts.endpoint ?? opts.cdp;
  if (!endpoint && !opts.endpointFile) return null;
  const ep = resolveEndpoint({ endpoint, endpointFile: opts.endpointFile });
  assertLoopbackEndpoint(ep);
  return {
    cdp: endpoint ?? '',
    endpointFile: opts.endpointFile,
    browser: opts.browser ?? inferProviderId(ep),
    playwrightModule: opts.playwrightModule,
    owned: false,
    policy: { locked: false, filled: [] },
  };
}

/** Attach to the saved session, or to an explicit loopback endpoint. Policy state is persisted. */
export async function attach(opts: AttachOpts = {}): Promise<{
  actuator: WebActuator;
  session: SessionFile;
  persist: () => void;
}> {
  let s = loadSession();
  const ex = explicitSession(opts);
  if (ex) {
    const same =
      s &&
      s.cdp === ex.cdp &&
      s.endpointFile === ex.endpointFile &&
      (s.browser ?? 'chromium-cdp') === ex.browser;
    if (!same) s = ex;
    else if (s && opts.browser) s.browser = opts.browser;
  }
  if (!s)
    throw new BlindfillError(
      'ACTUATOR',
      'no browser session: run `blindfill session start`, `blindfill session attach --endpoint <url>` or pass --endpoint',
    );
  const session = s;
  const provider = getProvider(session.browser ?? 'chromium-cdp');
  if (!provider.attachable)
    throw new BlindfillError('ACTUATOR', `provider ${provider.id} cannot be attached from a saved session`);
  const policy = new SessionPolicy(session.policy);
  const actuator = await WebActuator.fromProvider(
    provider.id,
    {
      endpoint: session.cdp || undefined,
      endpointFile: session.endpointFile,
      urlIncludes: opts.urlIncludes,
      pageIndex: opts.pageIndex,
      playwrightModule: opts.playwrightModule ?? session.playwrightModule,
    },
    policy,
  );
  const persist = () => saveSession({ ...session, policy: policy.snapshot() });
  return { actuator, session, persist };
}

/** `session attach`: verify the endpoint works (one connect), then remember it. No page is opened. */
export async function attachSession(opts: AttachOpts): Promise<{
  browser: string;
  endpoint: string;
  capabilities: unknown;
  pages: { index: number; origin: string }[];
}> {
  const ex = explicitSession(opts);
  if (!ex)
    throw new BlindfillError(
      'POLICY',
      'usage: blindfill session attach --endpoint <url> | --endpoint-file <json>',
    );
  const existing = loadSession();
  if (existing?.owned && existing.pid && alive(existing.pid))
    throw new BlindfillError(
      'POLICY',
      'a blindfill-owned session is running; run `blindfill session stop` first',
    );
  saveSession(ex);
  let actuator: WebActuator | undefined;
  try {
    ({ actuator } = await attach(opts));
    const pages = actuator.page
      .context()
      .pages()
      .map((p, index) => ({ index, origin: safeOrigin(p.url()) }));
    return {
      browser: ex.browser as string,
      endpoint: redactEndpoint(
        resolveEndpoint({ endpoint: ex.cdp || undefined, endpointFile: ex.endpointFile }),
      ),
      capabilities: actuator.capabilities,
      pages,
    };
  } catch (e) {
    rmSync(file(), { force: true }); // do not remember an endpoint that does not work
    throw e;
  } finally {
    await actuator?.close();
  }
}

export function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : u.protocol;
  } catch {
    return '';
  }
}

export async function stopSession(): Promise<{ stopped: boolean; killed: boolean }> {
  const s = loadSession();
  if (!s) return { stopped: false, killed: false };
  let killed = false;
  if (s.owned && s.pid && alive(s.pid)) {
    try {
      process.kill(s.pid, 'SIGTERM');
      for (let i = 0; i < 30 && alive(s.pid); i++) await sleep(100);
      if (alive(s.pid)) process.kill(s.pid, 'SIGKILL');
      killed = true;
    } catch {
      /* ignore */
    }
  }
  if (s.userDataDir) {
    await sleep(200);
    rmSync(s.userDataDir, { recursive: true, force: true });
  }
  rmSync(file(), { force: true });
  return { stopped: true, killed };
}
