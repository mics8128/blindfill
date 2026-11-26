import { appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { globalScrubber } from './scrubber.js';

export interface AuditEntry {
  event: 'fill' | 'totp' | 'refused' | 'submit' | 'session' | 'probe' | 'selftest' | 'item' | 'passkey';
  backend?: string;
  item?: string; // item id, never the name unless configured
  target?: string;
  fields?: string[]; // field NAMES only
  outcome?: string;
  reason?: string;
}

export function stateDir(): string {
  return process.env.BLINDFILL_STATE_DIR ?? join(homedir(), '.local', 'state', 'blindfill');
}

export function auditPath(): string {
  return process.env.BLINDFILL_AUDIT_FILE ?? join(stateDir(), 'audit.jsonl');
}

/** Append-only JSONL. The entry type has no value-carrying field; strings are scrubbed anyway. */
export function audit(entry: AuditEntry, path = auditPath()): void {
  const rec = { ts: new Date().toISOString(), pid: process.pid, ...entry };
  const line = globalScrubber.scrub(JSON.stringify(rec)) + '\n';
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line, { flag: 'a', mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  } catch {
    // auditing must not break a fill, but we never fall back to printing
  }
}
