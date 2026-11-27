import { execFileSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';

const win = process.platform === 'win32';
const USERS = '*S-1-5-32-545'; // BUILTIN\Users by SID (names are localized)

/** Let other local users read (POSIX 0644/0755, or a Users read ACE on Windows). */
export function shareWithOthers(path: string): void {
  if (win) execFileSync('icacls', [path, '/grant', `${USERS}:(R)`]);
  else chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644);
}

/** Undo shareWithOthers (back to 0600/0700, or remove the Users ACE). */
export function makePrivate(path: string): void {
  if (win) execFileSync('icacls', [path, '/remove:g', USERS]);
  else chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
}
