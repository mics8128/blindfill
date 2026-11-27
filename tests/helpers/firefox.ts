import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Self-launched, isolated Camoufox (Firefox) for the opt-in tests (BLINDFILL_TEST_FIREFOX=1).
 * Uses a throw-away HOME/XDG_RUNTIME_DIR and a temp profile (Playwright launchServer). Never connects to
 * or touches the owner's running browser: only read access to the installed Camoufox binaries.
 */
export interface FirefoxServer {
  endpoint: string;
  /** Marionette host:port of the same browser (for passkeys) */
  marionette: string;
  kind: string;
  stop: () => Promise<void>;
}

// Started like Ollie's shared Camoufox: -marionette and the WebAuthn softtoken prefs. Port 0 (Firefox
// writes the port it took to MarionetteActivePort in the profile) so it never collides with a running 2828.
const SERVE_PY = `
import sys
from camoufox.server import launch_server
launch_server(headless=True, args=['-marionette'], firefox_user_prefs={
  'marionette.port': 0,
  'security.webauth.webauthn_enable_softtoken': True,
  'security.webauth.webauthn_enable_usbtoken': False,
})
`;

function pythonCandidates(): string[] {
  return [
    process.env.BLINDFILL_CAMOUFOX_PYTHON,
    join(homedir(), '.local/share/camoufox-runtime/bin/python'),
  ].filter((p): p is string => !!p && existsSync(p));
}

export function firefoxTestsEnabled(): boolean {
  return process.env.BLINDFILL_TEST_FIREFOX === '1' && pythonCandidates().length > 0;
}

export async function startCamoufoxServer(): Promise<FirefoxServer> {
  const py = pythonCandidates()[0];
  const root = mkdtempSync(join(tmpdir(), 'bf-ff-'));
  const home = join(root, 'home');
  const run = join(root, 'run');
  mkdirSync(home);
  mkdirSync(run, { mode: 0o700 });
  const cache =
    process.env.BLINDFILL_CAMOUFOX_CACHE ??
    (existsSync(join(homedir(), '.local/share/camoufox-data'))
      ? join(homedir(), '.local/share/camoufox-data')
      : undefined);
  const child: ChildProcess = spawn(py, ['-c', SERVE_PY], {
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: root, // the temp profile (and its MarionetteActivePort) lands under root
      XDG_RUNTIME_DIR: run,
      ...(cache ? { XDG_CACHE_HOME: cache } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  const endpoint = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('camoufox server did not start: ' + out.slice(-300))),
      60_000,
    );
    const on = (d: Buffer) => {
      out += d.toString();
      const m = out.match(/ws:\/\/\S+/);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    };
    child.stdout!.on('data', on);
    child.stderr!.on('data', on);
    child.on('exit', () => reject(new Error('camoufox server exited: ' + out.slice(-300))));
  });
  let marionette = '';
  for (let i = 0; i < 100 && !marionette; i++) {
    for (const d of readdirSync(root)) {
      const f = join(root, d, 'MarionetteActivePort');
      if (existsSync(f)) marionette = `127.0.0.1:${readFileSync(f, 'utf8').trim()}`;
    }
    if (!marionette) await new Promise((r) => setTimeout(r, 100));
  }
  if (!marionette) {
    process.kill(-child.pid!, 'SIGKILL');
    throw new Error('camoufox started without Marionette');
  }
  return {
    endpoint,
    marionette,
    kind: 'camoufox (python launch_server, headless, temp profile, -marionette + softtoken prefs)',
    stop: async () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        /* gone */
      }
      await new Promise((r) => setTimeout(r, 800));
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
