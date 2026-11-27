import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSession, saveSession, type SessionFile } from '../src/actuators/web/session.js';
import { shareWithOthers } from './helpers/share.js';
import { mkdirPrivate } from '../src/core/acl.js';

let dir: string;
let state: string;
const session = (locked: boolean, filled: string[], cdp = 'http://127.0.0.1:9222'): SessionFile => ({
  cdp,
  owned: false,
  policy: { locked, filled },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bf-session-'));
  state = join(dir, 'state');
  process.env.BLINDFILL_STATE_DIR = state;
});
afterEach(() => {
  delete process.env.BLINDFILL_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function writer(locked: boolean, entry: string, n: number): Promise<unknown> {
  const c = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/fixtures/save-session.ts', String(locked), entry, String(n)],
    { cwd: resolve('.'), env: { ...process.env, BLINDFILL_STATE_DIR: state }, stdio: 'inherit' },
  );
  const [code] = await once(c, 'exit');
  return code;
}

describe('session state (session.json)', () => {
  it('a stale snapshot cannot clear the lock or a one-shot record', () => {
    saveSession(session(true, ['o|password']));
    saveSession(session(false, ['o|pin']));
    expect(loadSession()?.policy).toMatchObject({ locked: true, filled: ['o|password', 'o|pin'] });
    // a different browser endpoint is a new session
    saveSession(session(false, [], 'http://127.0.0.1:9333'));
    expect(loadSession()?.policy).toMatchObject({ locked: false, filled: [] });
  });

  it('concurrent processes: lock stays set and no one-shot record is lost; atomic 0600 file', async () => {
    saveSession(session(false, []));
    const codes = await Promise.all([
      writer(true, 'o|password', 25),
      writer(false, 'o|a', 25),
      writer(false, 'o|b', 25),
      writer(false, 'o|c', 25),
    ]);
    expect(codes).toEqual([0, 0, 0, 0]);
    const s = loadSession();
    expect(s?.policy.locked).toBe(true);
    expect([...(s?.policy.filled ?? [])].sort()).toEqual(['o|a', 'o|b', 'o|c', 'o|password']);
    if (process.platform !== 'win32') expect(statSync(join(state, 'session.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(state)).toEqual(['session.json']); // no temp or lock file left behind
  }, 60_000);

  it('refuses a state dir that is group/world accessible or a symlink', () => {
    mkdirPrivate(state);
    shareWithOthers(state);
    expect(() => saveSession(session(true, []))).toThrow(/mode 0700/);
    expect(() => loadSession()).toThrow(/mode 0700/);
    rmSync(state, { recursive: true });
    const real = join(dir, 'real');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, state, 'junction'); // junction: Windows allows it without symlink privilege
    expect(() => saveSession(session(true, []))).toThrow(/not a symlink/);
  });
});
