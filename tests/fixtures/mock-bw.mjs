#!/usr/bin/env node
// Mock `bw` for tests. Items come from the JSON file in BLINDFILL_MOCK_BW_ITEMS.
// Requires BW_SESSION=mock-session-token, otherwise behaves like a locked vault.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2).filter((a) => a !== '--nointeraction');
const fail = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};
if (args[0] === '--version') {
  console.log('2099.1.0-mock');
  process.exit(0);
}
const locked = process.env.BW_SESSION !== 'mock-session-token';
if (args[0] === 'status') {
  console.log(JSON.stringify({ status: locked ? 'locked' : 'unlocked' }));
  process.exit(0);
}
if (locked) fail('Vault is locked.');
if (args.some((a) => a === '--session')) fail('mock: --session on the command line is forbidden');
const items = JSON.parse(readFileSync(process.env.BLINDFILL_MOCK_BW_ITEMS, 'utf8'));

function b32(s) {
  const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += al.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(seed) {
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', b32(seed)).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1000000;
  return String(n).padStart(6, '0');
}

const [verb, what, arg, arg2] = args;
if (verb === 'list' && what === 'items') {
  let res = items;
  if (arg === '--search') res = items.filter((i) => JSON.stringify([i.name, i.login?.username, i.login?.uris]).toLowerCase().includes(String(arg2).toLowerCase()));
  if (arg === '--url') {
    const host = new URL(arg2).hostname.split('.').slice(-2).join('.');
    res = items.filter((i) => (i.login?.uris ?? []).some((u) => u.uri && u.uri.includes('://') && new URL(u.uri).hostname.endsWith(host)));
  }
  console.log(JSON.stringify(res));
} else if (verb === 'get' && what === 'item') {
  const it = items.find((i) => i.id === arg);
  if (!it) fail('Not found.');
  console.log(JSON.stringify(it));
} else if (verb === 'get' && what === 'totp') {
  const it = items.find((i) => i.id === arg);
  if (!it || !it.login?.totp) fail('Not found.');
  console.log(totp(it.login.totp));
} else if ((verb === 'create' || verb === 'edit') && what === 'item') {
  // body comes by stdin (base64 JSON); passing it as an argument would expose it in ps, so reject that
  if (verb === 'create' ? arg !== undefined : arg2 !== undefined) fail('mock: item JSON must come by stdin');
  const body = JSON.parse(Buffer.from(readFileSync(0, 'utf8').trim(), 'base64').toString('utf8'));
  const file = process.env.BLINDFILL_MOCK_BW_ITEMS;
  if (verb === 'create') {
    body.id = randomUUID();
    items.push(body);
  } else {
    const i = items.findIndex((x) => x.id === arg);
    if (i < 0) fail('Not found.');
    items[i] = { ...body, id: arg };
  }
  writeFileSync(file, JSON.stringify(items));
  console.log(JSON.stringify(verb === 'create' ? body : items.find((x) => x.id === arg)));
} else fail('mock: unsupported command ' + args.join(' '));
