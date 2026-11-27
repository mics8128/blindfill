import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import type { Backend } from '../src/backends/spi.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { generatePassword, passwordMatches } from '../src/password.js';
import { startSites } from './helpers/sites.js';

const MOCK = resolve('tests/fixtures/mock-bw.mjs');
let dir: string;
let file: string;
let sites: Awaited<ReturnType<typeof startSites>>;
let browser: Browser;
const outputs: string[] = [];

const backend = () => new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
const stored = () =>
  JSON.parse(readFileSync(file, 'utf8')) as {
    id: string;
    name: string;
    login: { password: string };
    fields: { name: string; value: string }[];
  }[];
const O = () => `http://good.localhost:${sites.port}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bf-items-'));
  file = join(dir, 'items.json');
  writeFileSync(file, '[]');
  process.env.BLINDFILL_MOCK_BW_ITEMS = file;
  process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
  sites = await startSites();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('password policy + generation', () => {
  it('generated values always satisfy the policy; invalid policies are refused', () => {
    const policy = {
      version: 1 as const,
      min_length: 10,
      max_length: 14,
      min_special: 2,
      allowed_special: '!#',
      max_consecutive_identical: 2,
    };
    for (let i = 0; i < 50; i++) expect(passwordMatches(generatePassword(policy), policy)).toBe(true);
    expect(generatePassword(undefined, 40)).toHaveLength(40);
    expect(() => generatePassword({ version: 1, min_length: 4 } as never)).toThrow(/invalid password policy/);
    expect(() => generatePassword({ version: 1, bogus: 1 } as never)).toThrow(/invalid password policy/);
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe('item generate / create / password-policy (bw, mock)', () => {
  it('generate: saved with opt-in + policy, value never returned; stored value satisfies the policy', async () => {
    const eng = new Engine(backend());
    const policy = { version: 1, min_length: 12, max_length: 16 };
    const r = await eng.itemGenerate({
      name: 'gen-1',
      origins: [O()],
      username: 'bob',
      displayName: 'Bob',
      policy,
    });
    outputs.push(JSON.stringify(r));
    expect(r).toMatchObject({
      password_generated: true,
      secret_exposed: false,
      registration_outcome: 'not_attempted',
    });
    const raw = stored().find((i) => i.name === 'gen-1')!;
    expect(passwordMatches(raw.login.password, policy as never)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(raw.login.password);
    const show = await eng.itemShow({ item: raw.id });
    outputs.push(JSON.stringify(show));
    expect(JSON.stringify(show)).not.toContain(raw.login.password);
    expect(show.secretFields).toContain('password');
    expect(show.readable.display_name).toBe('Bob');
    const meta = await backend().meta({ backend: 'bw', id: raw.id });
    expect(meta.control.registration).toBe(true);
    expect(meta.control.passwordPolicy).toEqual(policy);
    // the password is write-only: reading it is refused
    await expect(backend().read({ backend: 'bw', id: raw.id }, 'password')).rejects.toMatchObject({
      code: 'SECRET_ACCESS',
    });
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).not.toContain(raw.login.password);
  });

  it('refuses duplicate names, bad origins, bad policy, and unsupported backends', async () => {
    const eng = new Engine(backend());
    const base = { name: 'gen-2', origins: [O()], username: 'bob' };
    await expect(eng.itemGenerate({ ...base, name: 'gen-1' })).rejects.toThrow(/already exists/);
    for (const o of [
      'http://example.com',
      'https://example.com/path',
      'https://example.com/?q=1',
      'ftp://x',
      'nonsense',
      'https://u:p@example.com',
    ])
      await expect(eng.itemGenerate({ ...base, origins: [o] })).rejects.toMatchObject({ code: 'POLICY' });
    await expect(eng.itemGenerate({ ...base, origins: [] })).rejects.toMatchObject({ code: 'POLICY' });
    await expect(eng.itemGenerate({ ...base, username: '' })).rejects.toMatchObject({ code: 'POLICY' });
    await expect(
      eng.itemGenerate({ ...base, origins: [], androidApp: 'com.example/../x' }),
    ).rejects.toMatchObject({ code: 'POLICY' });
    await expect(eng.itemGenerate({ ...base, policy: { version: 1, min_length: 2 } })).rejects.toThrow(
      /invalid password policy/,
    );
    expect(stored().some((i) => i.name === 'gen-2')).toBe(false);
    const ro = {
      ...backend(),
      capabilities: new Set(['SEARCH']),
      createItem: undefined,
    } as unknown as Backend;
    await expect(new Engine(ro).itemGenerate(base)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('generate --android: binds androidapp://<package> with no signer pin, origins optional', async () => {
    const eng = new Engine(backend());
    const r = await eng.itemGenerate({
      name: 'gen-app',
      origins: [],
      username: 'bob',
      androidApp: 'com.example.app',
    });
    expect(r).toMatchObject({ android_app: 'com.example.app', registration_enabled: true });
    const raw = stored().find((i) => i.name === 'gen-app')!;
    expect(JSON.stringify(r)).not.toContain(raw.login.password);
    const meta = await backend().meta({ backend: 'bw', id: raw.id });
    expect(meta.uris.map((u) => u.uri)).toEqual(['androidapp://com.example.app']);
    expect(meta.control.signers).toEqual([]);
  });

  it('create: origin-bound item from supplied values; password never echoed', async () => {
    const eng = new Engine(backend());
    const pw = 'Sup3r-Secret-for-test-create-1!';
    const r = await eng.itemCreate({ origins: [O()], username: 'carol', password: pw });
    outputs.push(JSON.stringify(r));
    expect(JSON.stringify(r)).not.toContain(pw);
    expect(r.name).toBe(`good.localhost:${sites.port}/carol`);
    expect(stored().find((i) => i.id === r.id)!.login.password).toBe(pw);
  });

  it('password-policy: read and replace (human only); never changes the password', async () => {
    const eng = new Engine(backend());
    const id = stored().find((i) => i.name === 'gen-1')!.id;
    const before = stored().find((i) => i.id === id)!.login.password;
    const policy = { version: 1, min_length: 9, max_length: 20 };
    // an agent-set policy would be an oracle on the stored password at register time
    await expect(eng.itemPasswordPolicy({ item: id }, policy)).rejects.toThrow(/terminal/);
    const r = await eng.itemPasswordPolicy({ item: id }, policy, true);
    expect(r).toMatchObject({ policy_updated: true, password_changed: false });
    expect(stored().find((i) => i.id === id)!.login.password).toBe(before);
    await expect(eng.itemPasswordPolicy({ item: id }, { version: 1, min_length: 1 }, true)).rejects.toThrow(
      /invalid password policy/,
    );
  });

  it('updateSecret / updateItem: secret fields are write-only', async () => {
    const b = backend();
    const id = stored().find((i) => i.name === 'gen-1')!.id;
    await b.updateSecret({ backend: 'bw', id }, 'password', 'replaced-pw-123!A');
    expect(stored().find((i) => i.id === id)!.login.password).toBe('replaced-pw-123!A');
    await expect(b.updateSecret({ backend: 'bw', id }, 'nosuch', 'x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(b.updateItem({ backend: 'bw', id }, { fields: { password: 'x' } })).resolves.toBeUndefined(); // a plain field named password is not the login secret
  });

  it('generate then register end to end: the generated value is typed into both fields; no output contains it', async () => {
    const eng0 = new Engine(backend());
    const policy = { version: 1, min_length: 14, max_length: 14 };
    const r = await eng0.itemGenerate({ name: 'gen-e2e', origins: [O()], username: 'dave', policy });
    outputs.push(JSON.stringify(r));
    const raw = stored().find((i) => i.name === 'gen-e2e')!;
    // a registration rule is a local private file, so no secret and no vault edit is needed
    const rule = {
      id: 'signup',
      mode: 'registration',
      top_origin: O(),
      form: '#signup',
      fields: { username: '#login', password: '#pw1' },
      confirm_password: '#pw2',
      submit: { selector: '#create', kind: 'native' },
    };
    await backend().updateItem(
      { backend: 'bw', id: raw.id },
      { fields: { 'blindfill.rules': JSON.stringify({ version: 2, rules: [rule] }) } },
    );
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const eng = new Engine(backend(), WebActuator.fromPage(page));
    sites.received.length = 0;
    const out = await eng.register({ item: raw.id, url: `${O()}/register`, rule: 'signup', submit: true });
    outputs.push(JSON.stringify(out));
    expect(out.submitted).toBe(true);
    await vi.waitFor(() => expect(sites.received).toHaveLength(1), { timeout: 5000 });
    expect(sites.received[0].fields.password).toBe(raw.login.password);
    expect(sites.received[0].fields.confirm).toBe(raw.login.password);
    expect(sites.received[0].fields.login).toBe('dave');
    for (const o of outputs) expect(o).not.toContain(raw.login.password);
    expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).not.toContain(raw.login.password);
  }, 60_000);

  it('CLI item generate prints no password, in stdout or stderr', async () => {
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ backend: 'bw', backends: { bw: { bin: MOCK } } }));
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', 'src/cli.ts', ...args],
          {
            env: {
              ...process.env,
              BLINDFILL_CONFIG: cfg,
              BW_SESSION: 'mock-session-token',
              BLINDFILL_STATE_DIR: join(dir, 'state'),
            },
            cwd: resolve('.'),
          },
          (e, stdout, stderr) => res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr }),
        );
      });
    const r = await run([
      'item',
      'generate',
      'cli-gen',
      '--origin',
      O(),
      '--username',
      'erin',
      '--length',
      '24',
    ]);
    expect(r.code).toBe(0);
    const raw = stored().find((i) => i.name === 'cli-gen')!;
    expect(raw.login.password).toHaveLength(24);
    expect(r.stdout + r.stderr).not.toContain(raw.login.password);
    expect(JSON.parse(r.stdout)).toMatchObject({ password_generated: true, secret_exposed: false });
    const again = await run(['item', 'generate', 'cli-gen', '--origin', O(), '--username', 'erin']);
    expect(again.code).toBe(1);
    const tty = await run(['item', 'create', '--origin', O(), '--username', 'x']);
    expect(tty.code).toBe(1);
    expect(tty.stdout).toContain('terminal');
  }, 60_000);
});

describe('item admin', () => {
  it('list / status expose names and classes, never values', async () => {
    const eng = new Engine(backend());
    const raw = stored().find((i) => i.name === 'gen-e2e')!;
    const l = JSON.stringify(await eng.itemList('gen-'));
    const st = JSON.stringify(await eng.itemStatus({ item: raw.id }));
    outputs.push(l, st);
    expect(l).toContain('gen-e2e');
    expect(st).toContain('"class":"secret"');
    expect(st).toContain('"registration_allowed":true');
    for (const o of [l, st]) expect(o).not.toContain(raw.login.password);
  });

  it('rename: unique names only, nothing else changes', async () => {
    const eng = new Engine(backend());
    const raw = stored().find((i) => i.name === 'gen-e2e')!;
    await expect(eng.itemRename({ item: raw.id }, 'gen-1')).rejects.toThrow(/already exists/);
    await eng.itemRename({ item: raw.id }, 'gen-e2e-renamed');
    const after = stored().find((i) => i.id === raw.id)!;
    expect(after.name).toBe('gen-e2e-renamed');
    expect(after.login.password).toBe(raw.login.password);
  });

  it('edit: readable fields freely; origins / blindfill.* / secrets only with a human; secrets never readable', async () => {
    const eng = new Engine(backend());
    const raw = stored().find((i) => i.name === 'gen-1')!;
    await eng.itemEdit({ item: raw.id }, { set: { store_id: 'S-9' }, human: false });
    expect(
      stored()
        .find((i) => i.id === raw.id)!
        .fields.find((f) => f.name === 'store_id')!.value,
    ).toBe('S-9');
    await eng.itemEdit({ item: raw.id }, { unset: ['store_id'], human: false });
    expect(
      stored()
        .find((i) => i.id === raw.id)!
        .fields.some((f) => f.name === 'store_id'),
    ).toBe(false);
    const sensitive: Partial<Parameters<Engine['itemEdit']>[1]>[] = [
      { origins: ['https://evil.example'] },
      { set: { 'blindfill.registration': 'allow' } },
      { unset: ['blindfill.password_policy'] },
      { secrets: { password: 'new-secret-value-1!' } },
    ];
    for (const s of sensitive)
      await expect(eng.itemEdit({ item: raw.id }, { ...s, human: false })).rejects.toThrow(
        /human at a terminal/,
      );
    expect(stored().find((i) => i.id === raw.id)!.login.password).not.toBe('new-secret-value-1!');
    // blindfill.rules is agent-editable without a terminal (owner decision 2026-11-27), still validated
    const rules = '{"version":2,"rules":[]}';
    await eng.itemEdit({ item: raw.id }, { set: { 'Blindfill.Rules': rules }, human: false });
    expect(
      stored()
        .find((i) => i.id === raw.id)!
        .fields.find((f) => f.name === 'Blindfill.Rules')?.value,
    ).toBe(rules);
    await expect(
      eng.itemEdit({ item: raw.id }, { set: { 'blindfill.rules': '{"version":9}' }, human: false }),
    ).rejects.toThrow();
    await expect(
      eng.itemEdit({ item: raw.id }, { set: { password: 'x' }, human: true }),
    ).rejects.toMatchObject({ code: 'SECRET_ACCESS' });
    await expect(eng.itemEdit({ item: raw.id }, { human: true })).rejects.toThrow(/nothing to change/);
    await expect(
      eng.itemEdit({ item: raw.id }, { secrets: { nosuch: 'x' }, human: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      eng.itemEdit({ item: raw.id }, { origins: ['https://x.example/path'], human: true }),
    ).rejects.toMatchObject({ code: 'POLICY' });
    const r = await eng.itemEdit(
      { item: raw.id },
      { origins: ['https://ok.example'], secrets: { password: 'new-secret-value-1!' }, human: true },
    );
    outputs.push(JSON.stringify(r));
    expect(JSON.stringify(r)).not.toContain('new-secret-value-1!');
    const after = stored().find((i) => i.id === raw.id)!;
    expect(after.login.password).toBe('new-secret-value-1!');
    expect((after as unknown as { login: { uris: { uri: string }[] } }).login.uris[0].uri).toBe(
      'https://ok.example',
    );
  });

  it('there is no reveal command (CLI refuses, usage lists none)', async () => {
    const cfg = join(dir, 'config.json');
    const r = await new Promise<{ code: number; stdout: string }>((res) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'item', 'reveal', '--item', 'x'],
        {
          env: {
            ...process.env,
            BLINDFILL_CONFIG: cfg,
            BW_SESSION: 'mock-session-token',
            BLINDFILL_STATE_DIR: join(dir, 'state'),
          },
          cwd: resolve('.'),
        },
        (e, stdout, stderr) =>
          res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout: stdout + stderr }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('usage');
  }, 30_000);
});
