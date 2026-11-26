import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '../spi.js';
import { FAKE, SECRET_NEEDLES } from './fixtures.js';
import { SecretHandle } from '../../core/secret.js';
import { BlindfillError, parseTarget } from '../../core/index.js';

export interface ContractSetup {
  backend: Backend;
  cleanup?: () => void | Promise<void>;
  /** item ids in this backend's namespace; defaults to the FAKE ids */
  ids?: { main?: string; missing?: string; android?: string };
  /** a search string that finds the FAKE item by name/path */
  query?: string;
  /** expected item name (defaults to FAKE.name) */
  name?: string;
}
export interface ContractOptions {
  /** Backend can hold custom fields (Hidden vs Text). */
  hiddenFields: boolean;
  totp: boolean;
  /** Backend can bind androidapp:// URIs. */
  android: boolean;
}

/**
 * Backend contract suite. EVERY backend must pass this against fixtures.
 * `setup({locked})` builds a backend wired to a fixture with the FAKE item (see fixtures.ts).
 */
export function runBackendContract(
  label: string,
  setup: (o: { locked: boolean }) => Promise<ContractSetup>,
  opts: ContractOptions,
): void {
  describe(`backend contract: ${label}`, () => {
    const cleanups: (() => void | Promise<void>)[] = [];
    const out: string[] = [];
    const spies: ReturnType<typeof vi.spyOn>[] = [];

    let ref = { backend: label, id: FAKE.id };
    let missing = { backend: label, id: FAKE.missingId };
    let androidId: string = FAKE.androidId;
    let query = 'shop';
    let itemName: string = FAKE.name;
    async function make(locked = false) {
      const s = await setup({ locked });
      if (s.cleanup) cleanups.push(s.cleanup);
      ref = { backend: label, id: s.ids?.main ?? FAKE.id };
      missing = { backend: label, id: s.ids?.missing ?? FAKE.missingId };
      androidId = s.ids?.android ?? FAKE.androidId;
      query = s.query ?? 'shop';
      itemName = s.name ?? FAKE.name;
      return s.backend;
    }

    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
      spies.splice(0).forEach((s) => s.mockRestore());
    });

    function captureOutput() {
      spies.push(
        vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
          out.push(String(c));
          return true;
        }) as never),
        vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
          out.push(String(c));
          return true;
        }) as never),
      );
    }

    it('declares id, tier and capabilities', async () => {
      const b = await make();
      expect(b.id).toBeTruthy();
      expect(['verified', 'blind-written/unverified', 'community-verified']).toContain(b.tier);
      expect(b.capabilities.has('SEARCH')).toBe(true);
      expect(b.capabilities.has('TOTP')).toBe(opts.totp);
      expect(typeof (await b.version())).toBe('string');
    });

    it('find: by query and by bound web target; unbound target returns nothing', async () => {
      const b = await make();
      await b.unlock();
      const byQuery = await b.find({ query });
      expect(byQuery.map((r) => r.id)).toContain(ref.id);
      const bound = await b.find({ target: parseTarget('web:https://shop.example.test') });
      expect(bound.map((r) => r.id)).toEqual([ref.id]);
      const other = await b.find({ target: parseTarget('web:https://evil.example.test') });
      expect(other).toEqual([]);
      const lookalike = await b.find({ target: parseTarget('web:https://shop.example.test.evil.test') });
      expect(lookalike).toEqual([]);
    });

    it('meta: readable values + secret field NAMES only, no secret values anywhere', async () => {
      const b = await make();
      const m = await b.meta(ref);
      expect(m.name).toBe(itemName);
      expect(m.username).toBe(FAKE.username);
      expect(m.uris.map((u) => u.uri)).toContain(FAKE.uri);
      expect(m.secretFields).toContain('password');
      expect(m.hasTotp).toBe(opts.totp);
      if (opts.hiddenFields) {
        expect(m.readable[FAKE.text.name]).toBe(FAKE.text.value);
        expect(m.secretFields).toContain(FAKE.hidden.name);
        expect(m.readable[FAKE.hidden.name]).toBeUndefined();
      }
      const json = JSON.stringify(m);
      for (const n of SECRET_NEEDLES) expect(json).not.toContain(n);
      expect(json).not.toContain('CANARY-notes');
      expect(m.notes).toBeUndefined();
    });

    it('read: readable fields yes; secret fields throw SECRET_ACCESS', async () => {
      const b = await make();
      expect(await b.read(ref, 'username')).toBe(FAKE.username);
      await expect(b.read(ref, 'password')).rejects.toMatchObject({ code: 'SECRET_ACCESS' });
      if (opts.hiddenFields) {
        expect(await b.read(ref, FAKE.text.name)).toBe(FAKE.text.value);
        await expect(b.read(ref, FAKE.hidden.name)).rejects.toMatchObject({ code: 'SECRET_ACCESS' });
      }
      await expect(b.read(ref, 'no-such-field')).rejects.toBeInstanceOf(BlindfillError);
    });

    it('openSecret: handle is write-only, delivers exact value once, zero-fills afterwards', async () => {
      const b = await make();
      const h = await b.openSecret(ref, 'password');
      expect(h).toBeInstanceOf(SecretHandle);
      expect(() => String(h)).toThrow();
      expect(() => JSON.stringify(h)).toThrow();
      expect(() => `${h}`).toThrow();
      let seen: Buffer | undefined;
      let equal = false;
      await h.into((buf) => {
        seen = buf;
        equal = buf.toString('utf8') === FAKE.password;
      });
      expect(equal).toBe(true);
      expect(seen!.every((x) => x === 0)).toBe(true);
      await expect(h.into(() => undefined)).rejects.toMatchObject({ code: 'SECRET_ACCESS' });
      if (opts.hiddenFields) {
        const h2 = await b.openSecret(ref, FAKE.hidden.name);
        let ok = false;
        await h2.into((buf) => void (ok = buf.toString() === FAKE.hidden.value));
        expect(ok).toBe(true);
        await expect(b.openSecret(ref, FAKE.text.name)).rejects.toBeInstanceOf(BlindfillError);
      }
      await expect(b.openSecret(ref, 'nope')).rejects.toBeInstanceOf(BlindfillError);
    });

    it('totpCode: current code only, seed never returned', async () => {
      const b = await make();
      if (!opts.totp) {
        await expect(b.totpCode(ref)).rejects.toBeInstanceOf(BlindfillError);
        return;
      }
      const code = await b.totpCode(ref);
      expect(code).toMatch(/^\d{6,8}$/);
      expect(code).not.toContain(FAKE.totpSeed);
    });

    it('missing item: NOT_FOUND', async () => {
      const b = await make();
      await expect(b.meta(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(b.openSecret(missing, 'password')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('locked vault: LOCKED, no interactive prompt', async () => {
      const b = await make(true);
      await expect(b.unlock()).rejects.toMatchObject({ code: 'LOCKED' });
      await expect(b.find({ query })).rejects.toMatchObject({ code: 'LOCKED' });
    });

    if (opts.android) {
      it('android: androidapp:// URI is returned intact and resolvable by package', async () => {
        const b = await make();
        const refs = await b.find({ target: { kind: 'android', pkg: FAKE.androidPkg } });
        expect(refs.map((r) => r.id)).toEqual([androidId]);
        const m = await b.meta(refs[0]);
        expect(m.uris.map((u) => u.uri)).toContain(`androidapp://${FAKE.androidPkg}`);
        expect(m.control.signers).toEqual(['AA:BB:CC:DD']);
      });
    }

    it('no secret reaches stdout/stderr or error messages', async () => {
      captureOutput();
      const b = await make();
      const msgs: string[] = [];
      const note = (e: unknown) => msgs.push(String((e as Error)?.message));
      await b.meta(ref);
      const h = await b.openSecret(ref, 'password');
      await h.into(() => undefined);
      await h.into(() => undefined).catch(note);
      await b.openSecret(missing, 'password').catch(note);
      await b.read(ref, 'password').catch(note);
      if (opts.totp) await b.totpCode(ref);
      const all = out.join('') + msgs.join('\n');
      for (const n of SECRET_NEEDLES) expect(all).not.toContain(n);
    });
  });
}
