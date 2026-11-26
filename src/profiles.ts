/**
 * Private, data-only login recipes ("profiles"). A recipe never expands authorization: the item's vault
 * URIs still decide which origins may receive a secret; a recipe only names the item, the page origin, the
 * rule to use (or an inline login rule) and which fields to fill. Ported in meaning from olliepm profiles.py.
 *
 * File: <configDir>/profiles/<name>.json, mode 0600, owned by you, one link, no symlinks, <= 64 KiB.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BlindfillError } from './core/types.js';
import { configDir, readPrivateFile, strictJson, validateRules, type Rule } from './rules.js';

const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const FIELD = /^[a-z][a-z0-9_.]{0,63}$/;

export interface ProfileDoc {
  version: 1;
  /** backend item id */
  item: string;
  /** optional human-readable item name; if present it must still match (detects a swapped item) */
  item_name?: string;
  web: {
    origin: string;
    /** rule id (looked up in the item's rules) or an inline login rule */
    rule: string | Rule;
    fields?: string[];
    submit: boolean;
  };
}

export interface Profile {
  name: string;
  doc: ProfileDoc;
  /** sha256 of the canonical JSON; pass it back to detect an edited recipe */
  revision: string;
}

const bad = (why: string): never => {
  throw new BlindfillError('POLICY', `invalid profile: ${why}`);
};

export function profilesDir(): string {
  return join(configDir(), 'profiles');
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export function validateProfile(raw: unknown, name = 'profile'): Profile {
  if (!ALIAS.test(name)) bad('name must be [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('expected an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!['version', 'item', 'item_name', 'web'].includes(k)) bad(`unknown key "${k}"`);
  if (o.version !== 1) bad('version must be 1');
  if (typeof o.item !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(o.item))
    bad('item must be a backend item id');
  if (
    o.item_name !== undefined &&
    (typeof o.item_name !== 'string' || !o.item_name || o.item_name.length > 200)
  )
    bad('item_name');
  const w = o.web as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') return bad('missing web target');
  for (const k of Object.keys(w))
    if (!['origin', 'rule', 'fields', 'submit'].includes(k)) bad(`unknown web key "${k}"`);
  let origin: string;
  try {
    const u = new URL(String(w.origin));
    if (
      !/^https?:$/.test(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !['', '/'].includes(u.pathname)
    )
      throw new Error();
    origin = u.origin;
  } catch {
    return bad('web.origin must be a bare http(s) origin');
  }
  if (w.submit !== undefined && typeof w.submit !== 'boolean') bad('web.submit must be boolean');
  let rule: string | Rule;
  if (typeof w.rule === 'string') {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(w.rule)) bad('web.rule id');
    rule = w.rule;
  } else {
    const [r] = validateRules([w.rule]);
    if ((r.mode ?? 'login') !== 'login') bad('a profile rule must be a login rule');
    rule = r;
  }
  let fields: string[] | undefined;
  if (w.fields !== undefined) {
    if (
      !Array.isArray(w.fields) ||
      !w.fields.length ||
      w.fields.length > 16 ||
      w.fields.some((f) => typeof f !== 'string' || !FIELD.test(f)) ||
      new Set(w.fields).size !== w.fields.length
    )
      bad('web.fields must be a unique list of field names');
    fields = w.fields as string[];
  }
  const doc: ProfileDoc = {
    version: 1,
    item: o.item as string,
    ...(o.item_name !== undefined ? { item_name: o.item_name as string } : {}),
    web: { origin, rule, ...(fields ? { fields } : {}), submit: w.submit === true },
  };
  if (JSON.stringify(doc).length > 65536) bad('too large');
  return { name, doc, revision: createHash('sha256').update(canonical(doc)).digest('hex') };
}

export function loadProfile(name: string, dir = profilesDir()): Profile {
  if (!ALIAS.test(name)) throw new BlindfillError('POLICY', 'invalid profile name');
  let text: string;
  try {
    text = readPrivateFile(dir, `${name}.json`);
  } catch (e) {
    if (e instanceof BlindfillError && e.message === 'file not found')
      throw new BlindfillError('NOT_FOUND', 'profile not found');
    throw e;
  }
  return validateProfile(strictJson(text), name);
}

/** One-time creation. Never overwrites; mode 0600; no vault access. */
export function createProfile(
  name: string,
  doc: unknown,
  dir = profilesDir(),
): { path: string; profile: Profile } {
  const profile = validateProfile(doc, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.getuid && st.uid !== process.getuid()) ||
    st.mode & 0o077
  )
    throw new BlindfillError('POLICY', 'profiles directory must be a private (0700) directory owned by you');
  const path = join(dir, `${name}.json`);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw new BlindfillError('POLICY', 'a profile with that name already exists (never overwritten)');
    throw new BlindfillError('POLICY', 'cannot create the profile file');
  }
  try {
    writeSync(fd, JSON.stringify(profile.doc, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { path, profile };
}
