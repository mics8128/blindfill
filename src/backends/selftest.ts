import type { Config } from '../config.js';
import { FAKE } from './_contract/fixtures.js';
import { KP_DB, KP_PASSWORD, fakeBw, fakeKeepass, fakeOp, fakePass, fakeRbw, fakeSecretTool } from './_contract/fake-runners.js';
import { BwBackend } from './bw.js';
import { KeepassxcBackend } from './keepassxc.js';
import { OpBackend } from './op.js';
import { PassBackend } from './pass.js';
import { RbwBackend } from './rbw.js';
import { SecretServiceBackend } from './secret-service.js';
import { createBackend } from './registry.js';
import type { Backend } from './spi.js';
import { BlindfillError } from '../core/types.js';

export interface SelftestStep {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface SelftestReport {
  backend: string;
  tier: string;
  mode: 'live' | 'fixture';
  blindfillVersion: string;
  toolVersion?: string;
  date: string;
  result: 'pass' | 'partial' | 'fail';
  steps: SelftestStep[];
  note: string;
}

export const SELFTEST_ITEM = 'blindfill-selftest';

/** Offline backends wired to in-memory fake CLIs. Proves blindfill's mapping, not the vendor CLI. */
export function fixtureBackend(id: string): { backend: Backend; query: string } {
  switch (id) {
    case 'bw': {
      const f = fakeBw(false);
      return { backend: new BwBackend({ runner: f.runner, env: f.env }), query: 'shop' };
    }
    case 'op':
      return { backend: new OpBackend({ runner: fakeOp(false) }), query: 'shop' };
    case 'rbw':
      return { backend: new RbwBackend({ runner: fakeRbw(false) }), query: 'shop' };
    case 'pass':
    case 'gopass': {
      const f = fakePass(false, id);
      return { backend: new PassBackend({ variant: id, runner: f.runner, lister: f.lister }), query: 'shop' };
    }
    case 'keepassxc':
      return {
        backend: new KeepassxcBackend({ runner: fakeKeepass(), db: KP_DB, env: { BLINDFILL_KEEPASS_PASSWORD: KP_PASSWORD } }),
        query: 'shop',
      };
    case 'secret-service':
      return { backend: new SecretServiceBackend({ runner: fakeSecretTool(false) }), query: 'shop' };
    default:
      throw new BlindfillError('UNSUPPORTED', `unknown backend "${id}"`);
  }
}

/**
 * Round trip a FAKE item (named `blindfill-selftest` in live mode) through a backend and report what
 * worked. The report never contains secret values, only booleans, lengths and versions.
 */
export async function runSelftest(
  id: string,
  opts: { fixture?: boolean; cfg?: Config; version?: string } = {},
): Promise<SelftestReport> {
  let backend: Backend;
  let query = SELFTEST_ITEM;
  if (opts.fixture) ({ backend, query } = fixtureBackend(id));
  else backend = createBackend(id, opts.cfg);
  const steps: SelftestStep[] = [];
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      steps.push({ name, ok: false, detail: `${(e as BlindfillError).code ?? 'ERR'}: ${String((e as Error).message).slice(0, 160)}` });
      return false;
    }
  };
  const report: SelftestReport = {
    backend: id,
    tier: backend.tier,
    mode: opts.fixture ? 'fixture' : 'live',
    blindfillVersion: opts.version ?? '0.1.0-alpha.0',
    date: new Date().toISOString().slice(0, 10),
    result: 'fail',
    steps,
    note: opts.fixture
      ? 'fixture mode runs against an in-memory fake CLI: it checks blindfill, NOT the vendor tool. Do not report it as a live verification.'
      : `live mode: uses ONLY the fake item named "${SELFTEST_ITEM}". Never point this at a real account item.`,
  };
  if (!(await step('tool version', async () => (report.toolVersion = await backend.version())))) return report;
  if (!(await step('vault unlocked (non-interactive)', () => backend.unlock()))) return report;
  let ref: Awaited<ReturnType<Backend['find']>>[number] | undefined;
  await step(`find item "${opts.fixture ? FAKE.name : SELFTEST_ITEM}"`, async () => {
    const refs = await backend.find({ query });
    if (refs.length !== 1) throw new BlindfillError('NOT_FOUND', `expected exactly 1 match, got ${refs.length}`);
    ref = refs[0];
  });
  if (!ref) return finish(report);
  const r = ref;
  let meta: Awaited<ReturnType<Backend['meta']>> | undefined;
  await step('meta: readable fields + secret field names', async () => {
    meta = await backend.meta(r);
    if (!meta.secretFields.includes('password')) throw new BlindfillError('NOT_FOUND', 'item has no password field');
    return `username ${meta.username ? 'present' : 'missing'}, ${meta.uris.length} uri(s), secret fields: ${meta.secretFields.join(', ')}`;
  });
  await step('read(password) is refused', async () => {
    try {
      await backend.read(r, 'password');
    } catch (e) {
      if ((e as BlindfillError).code === 'SECRET_ACCESS') return;
      throw e;
    }
    throw new Error('read() returned a secret-class field');
  });
  await step('openSecret(password) -> into(sink), zero-filled afterwards', async () => {
    const h = await backend.openSecret(r, 'password');
    let len = 0;
    let leaked = false;
    let kept: Buffer | undefined;
    await h.into((buf) => {
      kept = buf;
      len = buf.length;
      leaked = JSON.stringify(meta ?? {}).includes(buf.toString('utf8'));
    });
    if (leaked) throw new Error('meta() output contains the secret');
    if (!kept?.every((b) => b === 0)) throw new Error('buffer not zero-filled');
    if (len === 0) throw new Error('empty secret');
    return `delivered ${len} bytes to the sink (value not recorded)`;
  });
  if (meta && meta.hasTotp) await step('totp code', async () => {
    const c = await backend.totpCode(r);
    return `got a ${c.length}-digit code`;
  });
  else steps.push({ name: 'totp code', ok: true, detail: 'skipped: item has no TOTP' });
  return finish(report);
}

function finish(report: SelftestReport): SelftestReport {
  const bad = report.steps.filter((s) => !s.ok).length;
  report.result = bad === 0 ? 'pass' : report.steps.some((s) => s.ok && s.name.startsWith('openSecret')) ? 'partial' : 'fail';
  return report;
}
