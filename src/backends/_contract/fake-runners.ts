/**
 * In-memory stand-ins for vendor CLIs, written from the vendors' documented output formats.
 * They serve the FAKE item. Used by the contract tests and by `blindfill backend selftest --fixture`.
 * NOT evidence that a real vendor CLI behaves this way: that is what a live selftest is for.
 */
import type { Runner, RunResult } from '../runner.js';
import { FAKE, bwFixtureItems, totpFor } from './fixtures.js';

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', code: 0 });
const err = (stderr: string, code = 1): RunResult => ({ stdout: '', stderr, code });

export function fakeBw(locked: boolean): { runner: Runner; env: NodeJS.ProcessEnv } {
  const items = bwFixtureItems() as any[];
  const runner: Runner = async (_bin, a, o) => {
    const args = a.filter((x) => x !== '--nointeraction');
    if (args[0] === '--version') return ok('2099.1.0-fixture\n');
    if (o?.env?.BW_SESSION !== 'fixture-session' || locked)
      return args[0] === 'status' ? ok('{"status":"locked"}') : err('Vault is locked.');
    if (args[0] === 'status') return ok('{"status":"unlocked"}');
    if (args[0] === 'list') {
      const needle = String(args[3] ?? '').toLowerCase();
      const hit = (i: any) =>
        args[2] === '--search'
          ? JSON.stringify([i.name, i.login?.uris]).toLowerCase().includes(needle)
          : (i.login?.uris ?? []).some(
              (u: any) =>
                u.uri?.includes('://') &&
                new URL(u.uri).hostname.split('.').slice(-2).join('.') ===
                  new URL(needle).hostname.split('.').slice(-2).join('.'),
            );
      return ok(JSON.stringify(items.filter(hit)));
    }
    if (args[0] === 'get' && args[1] === 'item') {
      const it = items.find((i) => i.id === args[2]);
      return it ? ok(JSON.stringify(it)) : err('Not found.');
    }
    if (args[0] === 'get' && args[1] === 'totp') return ok(totpFor(FAKE.totpSeed) + '\n');
    return err('unsupported');
  };
  return { runner, env: { BW_SESSION: 'fixture-session' } };
}

export function fakeOp(locked: boolean): Runner {
  const item = {
    id: FAKE.id,
    title: FAKE.name,
    urls: [{ href: FAKE.uri, primary: true }],
    fields: [
      { label: 'username', purpose: 'USERNAME', type: 'STRING', value: FAKE.username },
      { label: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: FAKE.password },
      { label: 'one-time password', type: 'OTP', value: `otpauth://totp/x?secret=${FAKE.totpSeed}` },
      { label: FAKE.text.name, type: 'STRING', value: FAKE.text.value },
      { label: FAKE.hidden.name, type: 'CONCEALED', value: FAKE.hidden.value },
      { label: 'blindfill.submit', type: 'STRING', value: 'once' },
      { label: 'notesPlain', purpose: 'NOTES', type: 'STRING', value: 'CANARY-notes-should-stay-hidden' },
    ],
  };
  return async (_bin, a) => {
    if (a[0] === '--version') return ok('2.99.0-fixture\n');
    if (locked) return err('[ERROR] 2026/11/27 You are not signed in. Run `op signin`.');
    if (a[0] === 'whoami') return ok('{"account_uuid":"fake"}');
    if (a[0] === 'item' && a[1] === 'list')
      return ok(JSON.stringify([{ id: item.id, title: item.title, urls: item.urls }]));
    if (a[0] === 'item' && a[1] === 'get') {
      if (a[2] !== item.id) return err(`[ERROR] "${a[2]}" isn't an item in any vault`);
      return a.includes('--otp') ? ok(totpFor(FAKE.totpSeed) + '\n') : ok(JSON.stringify(item));
    }
    return err('unsupported');
  };
}

export function fakeRbw(locked: boolean): Runner {
  const item = {
    id: FAKE.id,
    name: FAKE.name,
    folder: null,
    notes: 'CANARY-notes-should-stay-hidden',
    data: {
      username: FAKE.username,
      password: FAKE.password,
      totp: FAKE.totpSeed,
      uris: [
        { uri: FAKE.uri, match_type: null },
        { uri: `androidapp://${FAKE.androidPkg}`, match_type: null },
      ],
    },
    fields: [
      { name: FAKE.text.name, value: FAKE.text.value, type: 'text' },
      { name: FAKE.hidden.name, value: FAKE.hidden.value, type: 'hidden' },
      { name: 'blindfill.signers', value: 'AA:BB:CC:DD', type: 'text' },
    ],
  };
  return async (_bin, a) => {
    if (a[0] === '--version') return ok('rbw 99.0.0-fixture\n');
    if (a[0] === 'unlocked') return locked ? err('locked') : ok('');
    if (locked) return err('rbw vault is locked');
    if (a[0] === 'list') return ok(`${item.id}\t${item.name}\t${FAKE.username}\n`);
    if (a[0] === 'get')
      return a[2] === item.id ? ok(JSON.stringify(item)) : err("couldn't find entry for '" + a[2] + "'");
    if (a[0] === 'code') return ok(totpFor(FAKE.totpSeed) + '\n');
    return err('unsupported');
  };
}

export const PASS_ID = 'sites/shop.example.test';

export function fakePass(
  locked: boolean,
  variant: 'pass' | 'gopass',
): { runner: Runner; lister: () => Promise<string[]> } {
  const text = [
    FAKE.password,
    `username: ${FAKE.username}`,
    `url: ${FAKE.uri}`,
    `otpauth://totp/x?secret=${FAKE.totpSeed}`,
    `${FAKE.text.name}: ${FAKE.text.value}`,
    `${FAKE.hidden.name}: ${FAKE.hidden.value}`,
    `blindfill.readable: ${FAKE.text.name}`,
    'CANARY-notes-should-stay-hidden',
    '',
  ].join('\n');
  const runner: Runner = async (_b, a) => {
    if (a[0] === '--version')
      return ok(
        variant === 'gopass'
          ? 'gopass 99.0.0-fixture\n'
          : '== pass: the standard unix password manager == fixture\n',
      );
    if (locked) return err('gpg: decryption failed: No secret key');
    if (a[0] === 'ls') return ok(`${PASS_ID}\nsites/other.example.test\n`);
    const id = a[a.length - 1];
    if (a[0] === 'show' && id === 'sites/other.example.test')
      return ok('decoy-pw\nurl: https://other.example.test/\n');
    if (a[0] === 'show') return id === PASS_ID ? ok(text) : err(`Error: ${id} is not in the password store.`);
    if (a[0] === 'otp')
      return id === PASS_ID ? ok(totpFor(FAKE.totpSeed) + '\n') : err('Error: not in the password store.');
    return err('unsupported');
  };
  const lister = async () => [PASS_ID, 'sites/other.example.test'];
  return { runner, lister };
}

export const KP_ID = 'Internet/Fake Shop';
export const KP_DB = '/fixture/db.kdbx';
export const KP_PASSWORD = 'fixture-db-password';

export function fakeKeepass(): Runner {
  const text = [
    `Title: Fake Shop`,
    `UserName: ${FAKE.username}`,
    `Password: ${FAKE.password}`,
    `URL: ${FAKE.uri}`,
    `Notes: CANARY-notes-should-stay-hidden`,
    `otp: otpauth://totp/x?secret=${FAKE.totpSeed}`,
    `${FAKE.text.name}: ${FAKE.text.value}`,
    `${FAKE.hidden.name}: ${FAKE.hidden.value}`,
    `blindfill.readable: ${FAKE.text.name}`,
    '',
  ].join('\n');
  return async (_b, a, o) => {
    if (a[0] === '--version') return ok('2.99.0-fixture\n');
    if (o?.input !== `${KP_PASSWORD}\n`)
      return err('Error while reading the database: Invalid credentials were provided, please try again.');
    if (a[0] === 'ls') return ok('Internet/\nInternet/Fake Shop\nInternet/Other\n');
    if (a[0] === 'show') {
      const id = a[a.length - 1];
      if (id === 'Internet/Other')
        return ok('Title: Other\nPassword: decoy-pw\nURL: https://other.example.test/\n');
      if (id !== KP_ID) return err(`Could not find entry with path ${id}.`);
      return a.includes('-t') ? ok(totpFor(FAKE.totpSeed) + '\n') : ok(text);
    }
    return err('unsupported');
  };
}

export const SS_ID = '/org/freedesktop/secrets/collection/login/1';

export function fakeSecretTool(locked: boolean): Runner {
  const block = [
    `[${SS_ID}]`,
    `label = Fake Shop`,
    `created = 2026-11-27 00:00:00`,
    `modified = 2026-11-27 00:00:00`,
    `schema = org.freedesktop.Secret.Generic`,
    `attribute.blindfill = 1`,
    `attribute.username = ${FAKE.username}`,
    `attribute.uri = ${FAKE.uri}`,
    `attribute.${FAKE.text.name} = ${FAKE.text.value}`,
    `attribute.${FAKE.hidden.name} = ${FAKE.hidden.value}`,
    `attribute.blindfill.readable = ${FAKE.text.name}`,
    `secret = ${FAKE.password}`,
    '',
  ].join('\n');
  return async (_b, a) => {
    if (a[0] === '--version') return ok('secret-tool fixture\n');
    if (locked) return err('secret-tool: Cannot get secret of a locked object');
    if (a[0] === 'search') return ok(block);
    return err('unsupported');
  };
}
