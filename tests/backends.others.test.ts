import { describe, expect, it } from 'vitest';
import { runBackendContract } from '../src/backends/_contract/index.js';
import {
  KP_DB,
  KP_ID,
  KP_PASSWORD,
  PASS_ID,
  SS_ID,
  fakeBw,
  fakeKeepass,
  fakeOp,
  fakePass,
  fakeRbw,
  fakeSecretTool,
} from '../src/backends/_contract/fake-runners.js';
import { FAKE } from '../src/backends/_contract/fixtures.js';
import { BwBackend } from '../src/backends/bw.js';
import { KeepassxcBackend } from '../src/backends/keepassxc.js';
import { OpBackend } from '../src/backends/op.js';
import { PassBackend } from '../src/backends/pass.js';
import { RbwBackend } from '../src/backends/rbw.js';
import { SecretServiceBackend } from '../src/backends/secret-service.js';
import { runSelftest } from '../src/backends/selftest.js';
import { BACKEND_INFO, createBackend } from '../src/backends/registry.js';

runBackendContract(
  'bw',
  async ({ locked }) => {
    const f = fakeBw(locked);
    return { backend: new BwBackend({ runner: f.runner, env: f.env }) };
  },
  { hiddenFields: true, totp: true, android: true },
);
runBackendContract('op', async ({ locked }) => ({ backend: new OpBackend({ runner: fakeOp(locked) }) }), {
  hiddenFields: true,
  totp: true,
  android: false,
});
runBackendContract(
  'rbw',
  async ({ locked }) => ({ backend: new RbwBackend({ runner: fakeRbw(locked) }), ids: { android: FAKE.id } }),
  {
    hiddenFields: true,
    totp: true,
    android: true,
  },
);
for (const variant of ['pass', 'gopass'] as const)
  runBackendContract(
    variant,
    async ({ locked }) => {
      const f = fakePass(locked, variant);
      return {
        backend: new PassBackend({ variant, runner: f.runner, lister: f.lister }),
        ids: { main: PASS_ID, missing: 'sites/nope' },
        name: 'shop.example.test',
      };
    },
    { hiddenFields: true, totp: true, android: false },
  );
runBackendContract(
  'keepassxc',
  async ({ locked }) => ({
    backend: new KeepassxcBackend({
      runner: fakeKeepass(),
      db: KP_DB,
      env: locked ? {} : { BLINDFILL_KEEPASS_PASSWORD: KP_PASSWORD },
    }),
    ids: { main: KP_ID, missing: 'Internet/Nope' },
  }),
  { hiddenFields: true, totp: true, android: false },
);
runBackendContract(
  'secret-service',
  async ({ locked }) => ({
    backend: new SecretServiceBackend({ runner: fakeSecretTool(locked) }),
    ids: { main: SS_ID, missing: '/org/freedesktop/secrets/collection/login/404' },
  }),
  { hiddenFields: true, totp: false, android: false },
);

describe('text-format backends fail closed', () => {
  it('pass: keys not listed in blindfill.readable are secret; notes hidden', async () => {
    const f = fakePass(false, 'pass');
    const b = new PassBackend({ runner: f.runner, lister: f.lister });
    const m = await b.meta({ backend: 'pass', id: PASS_ID });
    expect(m.secretFields).toContain(FAKE.hidden.name);
    expect(Object.keys(m.readable)).toEqual([FAKE.text.name]);
    expect(m.notes).toBeUndefined();
  });
  it('pass: rejects path traversal and option-like ids', async () => {
    const f = fakePass(false, 'pass');
    const b = new PassBackend({ runner: f.runner, lister: f.lister });
    await expect(b.meta({ backend: 'pass', id: '../../etc/passwd' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(b.meta({ backend: 'pass', id: '-c' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('keepassxc: password goes on stdin, never argv', async () => {
    const seen: string[][] = [];
    const inner = fakeKeepass();
    const b = new KeepassxcBackend({
      db: KP_DB,
      env: { BLINDFILL_KEEPASS_PASSWORD: KP_PASSWORD },
      runner: async (bin, args, o) => (seen.push(args), inner(bin, args, o)),
    });
    await b.meta({ backend: 'keepassxc', id: KP_ID });
    expect(seen.flat().join(' ')).not.toContain(KP_PASSWORD);
  });
});

describe('selftest (fixture mode) + registry', () => {
  for (const info of BACKEND_INFO)
    it(`selftest --fixture passes for ${info.id}`, async () => {
      const r = await runSelftest(info.id, { fixture: true });
      expect(r.steps.filter((s) => !s.ok)).toEqual([]);
      expect(r.result).toBe('pass');
      expect(r.mode).toBe('fixture');
      expect(JSON.stringify(r)).not.toContain(FAKE.password);
      expect(createBackend(info.id).tier).toBe(info.tier);
    });
  it('every non-bw backend is marked blind-written', () => {
    for (const i of BACKEND_INFO)
      expect(i.tier).toBe(i.id === 'bw' ? 'verified' : 'blind-written/unverified');
  });
});
