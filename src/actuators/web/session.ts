import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { stateDir } from '../../core/audit.js';
import { SessionPolicy } from '../../core/policy.js';
import { BlindfillError } from '../../core/types.js';
import { WebActuator, assertLoopbackEndpoint } from './web.js';

export interface SessionFile {
  cdp: string;
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
export async function startSession(opts: { headless?: boolean; executablePath?: string } = {}): Promise<SessionFile> {
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
    ...(opts.headless ?? true ? ['--headless=new'] : []),
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

/** Attach to the saved session, or to an explicit loopback CDP endpoint. Policy state is persisted. */
export async function attach(opts: { cdp?: string; urlIncludes?: string } = {}): Promise<{
  actuator: WebActuator;
  session: SessionFile;
  persist: () => void;
}> {
  let s = loadSession();
  if (opts.cdp) {
    assertLoopbackEndpoint(opts.cdp);
    if (!s || s.cdp !== opts.cdp) s = { cdp: opts.cdp, owned: false, policy: { locked: false, filled: [] } };
  }
  if (!s) throw new BlindfillError('ACTUATOR', 'no browser session: run `blindfill session start` or pass --cdp <loopback url>');
  const session = s;
  const policy = new SessionPolicy(session.policy);
  const actuator = await WebActuator.connectCDP(session.cdp, { urlIncludes: opts.urlIncludes, policy });
  const persist = () => saveSession({ ...session, policy: policy.snapshot() });
  return { actuator, session, persist };
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
