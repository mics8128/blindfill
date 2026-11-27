import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Windows has no POSIX owner/mode bits. Read owner and DACL by SID (account names are localized)
// through the built-in Windows PowerShell; no extra dependency.
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const CREATOR_OWNER = 'S-1-3-0'; // inherit-only placeholder: becomes the creator (us) on new children
const OWNER_RIGHTS = 'S-1-3-4';

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$t=[Security.Principal.SecurityIdentifier]',
  '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  'foreach($p in $env:BLINDFILL_ACL_PATHS -split [char]10){$a=Get-Acl -LiteralPath $p;' +
    '(@($a.GetOwner($t).Value)+@($a.GetAccessRules($true,$true,$t)|?{$_.AccessControlType -eq "Allow"}|%{$_.IdentityReference.Value})) -join " "}',
].join(';');

/**
 * Parse the script output: line 1 is the current user's SID, then one line per path,
 * "ownerSid allowSid...". Private = owned by us/SYSTEM/Administrators and every allow ACE
 * (inherit-only ones included, they reach future children) is for those principals.
 */
export function aclIsPrivate(out: string, count: number): boolean {
  const [me, ...rows] = out
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/));
  if (!me || me.length !== 1 || !me[0]!.startsWith('S-1-') || rows.length !== count) return false;
  const trusted = new Set([me[0]!, SYSTEM, ADMINISTRATORS]);
  return rows.every(
    ([owner, ...allowed]) =>
      trusted.has(owner!) &&
      allowed.every((s) => trusted.has(s) || s === CREATOR_OWNER || s === OWNER_RIGHTS),
  );
}

/** True when every path is private to this user on Windows. Fails closed on any error. */
export function windowsPathsPrivate(paths: string[]): boolean {
  const ps = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      env: { ...process.env, BLINDFILL_ACL_PATHS: paths.join('\n') },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return aclIsPrivate(out, paths.length);
  } catch {
    return false;
  }
}

/**
 * mkdir -p with the leaf private: mode 0700, and on Windows, when the leaf is new, an owner-only
 * DACL (no inheritance; me, SYSTEM, Administrators) as 0700 would give. An existing dir is left
 * as is: the callers' checks refuse it if it is not private.
 */
export function mkdirPrivate(dir: string): void {
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' || made === undefined) return;
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const me = /S-1-[\d-]+/.exec(
    execFileSync(join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  )?.[0];
  if (!me) throw new Error('cannot read the current user SID');
  const grants = [me, SYSTEM, ADMINISTRATORS].flatMap((s) => ['/grant:r', `*${s}:(OI)(CI)F`]);
  execFileSync(join(sys32, 'icacls.exe'), [dir, '/inheritance:r', ...grants], {
    stdio: 'ignore',
    windowsHide: true,
  });
}
