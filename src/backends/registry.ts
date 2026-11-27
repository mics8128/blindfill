import { existsSync, writeFileSync } from 'node:fs';
import { mkdirPrivate } from '../core/acl.js';
import { join } from 'node:path';
import { stateDir } from '../core/audit.js';
import { BlindfillError } from '../core/types.js';
import type { Config } from '../config.js';
import type { Backend, Tier } from './spi.js';
import { BwBackend } from './bw.js';
import { KeepassxcBackend } from './keepassxc.js';
import { OpBackend } from './op.js';
import { PassBackend } from './pass.js';
import { RbwBackend } from './rbw.js';
import { SecretServiceBackend } from './secret-service.js';

export interface BackendInfo {
  id: string;
  tier: Tier;
  title: string;
  binary: string;
  doc: string;
}

export const BACKEND_INFO: BackendInfo[] = [
  {
    id: 'bw',
    tier: 'verified',
    title: 'Bitwarden / Vaultwarden (bw CLI)',
    binary: 'bw',
    doc: 'docs/backends/bitwarden.md',
  },
  {
    id: 'secret-service',
    tier: 'blind-written/unverified',
    title: 'freedesktop Secret Service (secret-tool)',
    binary: 'secret-tool',
    doc: 'docs/backends/other.md',
  },
  {
    id: 'op',
    tier: 'blind-written/unverified',
    title: '1Password CLI (op)',
    binary: 'op',
    doc: 'docs/backends/other.md',
  },
  {
    id: 'keepassxc',
    tier: 'blind-written/unverified',
    title: 'KeePassXC (keepassxc-cli)',
    binary: 'keepassxc-cli',
    doc: 'docs/backends/other.md',
  },
  {
    id: 'pass',
    tier: 'blind-written/unverified',
    title: 'pass (password-store)',
    binary: 'pass',
    doc: 'docs/backends/other.md',
  },
  {
    id: 'gopass',
    tier: 'blind-written/unverified',
    title: 'gopass',
    binary: 'gopass',
    doc: 'docs/backends/other.md',
  },
  {
    id: 'rbw',
    tier: 'blind-written/unverified',
    title: 'rbw (unofficial Bitwarden CLI)',
    binary: 'rbw',
    doc: 'docs/backends/other.md',
  },
];

export function backendInfo(id: string): BackendInfo | undefined {
  return BACKEND_INFO.find((b) => b.id === id);
}

export function createBackend(id: string, cfg: Config = {}): Backend {
  const opts = cfg.backends?.[id] ?? {};
  switch (id) {
    case 'bw':
      return new BwBackend({ bin: opts.bin });
    case 'secret-service':
      return new SecretServiceBackend({ bin: opts.bin });
    case 'op':
      return new OpBackend({ bin: opts.bin });
    case 'keepassxc':
      return new KeepassxcBackend({
        bin: opts.bin,
        db: opts.db as string | undefined,
        keyFile: opts.keyFile as string | undefined,
      });
    case 'pass':
    case 'gopass':
      return new PassBackend({ variant: id, bin: opts.bin });
    case 'rbw':
      return new RbwBackend({ bin: opts.bin });
    default:
      throw new BlindfillError('UNSUPPORTED', `unknown backend "${id}" (see: blindfill backend list)`);
  }
}

/** One-line notice the first time an unverified backend is used on this machine. */
export function unverifiedNotice(b: Backend): string | null {
  if (b.tier !== 'blind-written/unverified') return null;
  const marker = join(stateDir(), `notice-${b.id}`);
  if (existsSync(marker)) return null;
  try {
    mkdirPrivate(stateDir());
    writeFileSync(marker, new Date().toISOString());
  } catch {
    /* ignore */
  }
  return `blindfill: backend "${b.id}" is unverified (blind-written, never run against a live vault). Please run \`blindfill backend selftest ${b.id}\` and report the result.`;
}
