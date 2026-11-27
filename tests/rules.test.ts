import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BwBackend } from '../src/backends/bw.js';
import { WebActuator } from '../src/actuators/web/web.js';
import { Engine } from '../src/engine.js';
import { globalScrubber } from '../src/core/scrubber.js';
import { createProfile, loadProfile, validateProfile } from '../src/profiles.js';
import { validateRules } from '../src/rules.js';
import { CANARY, CANARY_USER, startSites } from './helpers/sites.js';

const MOCK = resolve('tests/fixtures/mock-bw.mjs');
let browser: Browser;
let sites: Awaited<ReturnType<typeof startSites>>;
let dir: string;
let page: Page;
const outputs: string[] = [];
const keep = <T>(v: T): T => {
  outputs.push(JSON.stringify(v));
  return v;
};
const good = (p: string) => sites.url('good.localhost', p);
const goodOrigin = () => `http://good.localhost:${sites.port}`;
const cdnOrigin = () => `http://cdn.localhost:${sites.port}`;

const field = (name: string, value: string, type = 0) => ({ name, value, type });
const rules = (rs: unknown[]) => field('blindfill.rules', JSON.stringify({ version: 2, rules: rs }));
const item = (id: string, extra: unknown[] = [], uris = [`${goodOrigin()}/`]) => ({
  id,
  type: 1,
  name: `Fake ${id}`,
  login: {
    username: CANARY_USER,
    password: CANARY,
    totp: 'JBSWY3DPEHPK3PXP',
    uris: uris.map((uri) => ({ uri, match: 1 })),
  },
  fields: extra,
});

async function engine(): Promise<{ eng: Engine; act: WebActuator }> {
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  const act = WebActuator.fromPage(page);
  const backend = new BwBackend({ bin: MOCK, env: { ...process.env, BW_SESSION: 'mock-session-token' } });
  return { eng: new Engine(backend, act), act };
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  sites = await startSites();
  dir = mkdtempSync(join(tmpdir(), 'bf-rules-'));
  process.env.BLINDFILL_AUDIT_FILE = join(dir, 'audit.jsonl');
  process.env.BLINDFILL_CONFIG_DIR = join(dir, 'cfg');
  mkdirSync(join(dir, 'cfg'), { mode: 0o700 });
  const O = goodOrigin();
  const loginRule = {
    id: 'main',
    top_origin: O,
    form: '#signin',
    fields: { username: '#u', password: '#p' },
    submit: { selector: '#go', kind: 'native' },
  };
  const regRule = (extra: object = {}) => ({
    id: 'signup',
    mode: 'registration',
    top_origin: O,
    form: '#signup',
    fields: { username: '#login', password: '#pw1' },
    confirm_password: '#pw2',
    submit: { selector: '#create', kind: 'native' },
    ...extra,
  });
  const outsideRule = {
    id: 'eccang',
    top_origin: O,
    form: '#lf',
    fields: { username: '#em', password: '#pw' },
    submit: { selector: '#go', kind: 'js', outside_form: true },
  };
  const reg = field('blindfill.registration', 'allow');
  const policy = field(
    'blindfill.password_policy',
    JSON.stringify({ version: 1, min_length: 8, max_length: 12 }),
  );
  writeFileSync(
    join(dir, 'items.json'),
    JSON.stringify([
      item('plain'),
      item('ruled', [rules([loginRule])]),
      item('ruled-two', [rules([loginRule, { ...loginRule, id: 'second' }])]),
      item('badrule', [rules([{ ...loginRule, top_origin: 'http://elsewhere.localhost:1' }])]),
      item('reg', [reg, rules([regRule()])]),
      item('reg-noopt', [rules([regRule()])]),
      item('reg-policy', [reg, policy, rules([regRule()])]),
      item('reg-absent', [
        reg,
        rules([regRule({ id: 'one', confirm_password: undefined, password_confirmation: 'absent' })]),
      ]),
      item('jsrule', [
        rules([
          {
            id: 'js',
            top_origin: O,
            container: '#box',
            fields: { username: '#ju', password: '#jp' },
            submit: { selector: '#jgo', kind: 'click' },
          },
        ]),
      ]),
      item('outside', [rules([outsideRule])]),
      item('outside-both', [rules([outsideRule])], [`${O}/`, `${cdnOrigin()}/`]),
      item(
        'outside-framed',
        [rules([{ ...outsideRule, frame: { selector: 'iframe', origin: cdnOrigin() } }])],
        [`${O}/`, `${cdnOrigin()}/`],
      ),
      item('localonly'),
    ]),
  );
  process.env.BLINDFILL_MOCK_BW_ITEMS = join(dir, 'items.json');
  mkdirSync(join(dir, 'cfg', 'rules'), { mode: 0o700 });
  writeFileSync(
    join(dir, 'cfg', 'rules', 'localonly.json'),
    JSON.stringify({ version: 1, rules: [loginRule] }),
    { mode: 0o600 },
  );
});
afterAll(async () => {
  await browser?.close();
  await sites?.close();
  // nothing the tests ever produced may contain the password or the TOTP seed
  const all =
    outputs.join('\n') +
    (existsSync(join(dir, 'audit.jsonl')) ? readFileSync(join(dir, 'audit.jsonl'), 'utf8') : '');
  expect(all).not.toContain('CANARY-pw');
  expect(all).not.toContain('JBSWY3DPEHPK3PXP');
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  sites.received.length = 0;
  sites.requested.length = 0;
  globalScrubber.register(CANARY);
});

describe('explicit field rules', () => {
  it('validation: plain CSS only, unique ids, registration constraints', () => {
    const base = { id: 'a', top_origin: 'http://x.test', form: 'form', fields: { password: 'input' } };
    expect(validateRules([base])).toHaveLength(1);
    for (const sel of ['xpath=//input', 'text=Sign in', 'form >> input', 'css=input', 'internal:role=button'])
      expect(() => validateRules([{ ...base, fields: { password: sel } }])).toThrow(/plain CSS/);
    // value and input-state probes would make match/no-match errors an oracle on typed text
    for (const sel of [
      'input[value^="Ab"]',
      'input:placeholder-shown',
      'input:invalid',
      'form:has(input[value="x"])',
    ])
      expect(() => validateRules([{ ...base, fields: { password: sel } }])).toThrow(/values or input state/);
    for (const sel of ['input:nth-of-type(2)', 'input[name="a:b"]', 'form input:not([type=hidden])'])
      expect(validateRules([{ ...base, fields: { password: sel } }])).toHaveLength(1);
    expect(() => validateRules([base, base])).toThrow();
    expect(() => validateRules([{ ...base, form: undefined }])).toThrow();
    expect(() => validateRules([{ ...base, extra: 1 }])).toThrow(/unknown key/);
    expect(() => validateRules([{ ...base, top_origin: 'http://x.test/path' }])).toThrow(/bare/);
    expect(() => validateRules([{ ...base, mode: 'registration' }])).toThrow();
    expect(() =>
      validateRules([
        { ...base, container: 'div', form: undefined, submit: { selector: 'b', kind: 'native' } },
      ]),
    ).toThrow();
    // outside_form: form rules with a js submit only
    const out = { selector: '#go', kind: 'js', outside_form: true };
    expect(validateRules([{ ...base, submit: out }])[0].submit).toEqual(out);
    for (const bad of [
      { ...base, submit: { ...out, kind: 'native' } },
      { ...base, submit: { ...out, outside_form: 'yes' } },
      { ...base, form: undefined, container: 'div', submit: { ...out, kind: 'click' } },
    ])
      expect(() => validateRules([bad])).toThrow(/outside_form/);
  });

  it('item rule picks the right form among ambiguous ones; native POST submit; lock', async () => {
    const { eng } = await engine();
    const r = keep(
      await eng.fill({ item: 'ruled', url: good('/multi'), submit: true, expect: { urlIncludes: '/home' } }),
    );
    expect(r).toMatchObject({
      filled: ['username', 'password'],
      submitted: true,
      outcome: 'success',
      locked: true,
    });
    expect(sites.received).toHaveLength(1);
    expect(sites.received[0]).toMatchObject({ path: '/login', fields: { a1: CANARY_USER, a2: CANARY } });
  });

  it('a local private rules file works; a group-readable one is refused', async () => {
    const { eng } = await engine();
    const r = keep(await eng.fill({ item: 'localonly', url: good('/multi') }));
    expect(r.filled).toEqual(['username', 'password']);
    chmodSync(join(dir, 'cfg', 'rules', 'localonly.json'), 0o644);
    const { eng: eng2 } = await engine();
    await expect(eng2.fill({ item: 'localonly', url: good('/multi') })).rejects.toMatchObject({
      code: 'POLICY',
    });
    chmodSync(join(dir, 'cfg', 'rules', 'localonly.json'), 0o600);
  });

  it('rules never expand authorization: a rule for an origin the item does not bind is refused', async () => {
    const { eng } = await engine();
    await expect(eng.fill({ item: 'badrule', url: good('/multi'), rule: 'main' })).rejects.toMatchObject({
      code: 'ORIGIN_MISMATCH',
    });
    expect(sites.received).toHaveLength(0);
  });

  it('two login rules for one origin: stops and lists ids; an explicit rule works', async () => {
    const { eng } = await engine();
    const e = await eng.fill({ item: 'ruled-two', url: good('/multi') }).catch((x) => x);
    expect(e.code).toBe('AMBIGUOUS');
    expect(e.ruleIds).toEqual(['main', 'second']);
    const r = await eng.fill({ item: 'ruled-two', rule: 'second' });
    expect(r.filled).toEqual(['username', 'password']);
  });

  it('formless container rule with a role=button click submit', async () => {
    const { eng } = await engine();
    const r = keep(
      await eng.fill({
        item: 'jsrule',
        url: good('/js-login'),
        submit: true,
        expect: { urlIncludes: '/home' },
      }),
    );
    expect(r).toMatchObject({ submitted: true, outcome: 'success' });
    expect(sites.received[0].fields.password).toBe(CANARY);
  });

  describe('form rule with a js submit outside the form (eccang shape)', () => {
    const leaked = () => sites.requested.filter((u) => /CANARY|alice|^\/login\?/.test(u));

    it('fills, clicks the outside <a> once, success; nothing in any URL', async () => {
      const { eng } = await engine();
      const r = keep(
        await eng.fill({
          item: 'outside',
          url: good('/outside'),
          submit: true,
          expect: { urlIncludes: '/home' },
        }),
      );
      expect(r).toMatchObject({ filled: ['username', 'password'], submitted: true, outcome: 'success' });
      expect(sites.received).toHaveLength(1);
      expect(sites.received[0]).toMatchObject({
        path: '/login',
        fields: { email: CANARY_USER, password: CANARY },
      });
      expect(leaked()).toEqual([]);
    });

    it.each(['enter', 'submit'])(
      'the GET form submitted natively (trap=%s): values never reach a URL',
      async (trap) => {
        const { eng } = await engine();
        keep(await eng.fill({ item: 'outside', url: good(`/outside?trap=${trap}`), submit: true }));
        await page.waitForTimeout(300);
        expect(leaked()).toEqual([]);
      },
    );

    it.each([
      ['outside-both', '/outside-split'],
      ['outside-framed', '/outside-framed'],
    ])(
      '%s: a submit control in another frame / origin is refused before any secret is read',
      async (id, path) => {
        const { eng, act } = await engine();
        const err = await eng.fill({ item: id, url: good(path), submit: true }).catch((e) => e);
        expect(err).toMatchObject({ code: 'POLICY' });
        expect(String(err.message)).toMatch(/submit control/);
        expect(act.policy.locked).toBe(false);
        expect(sites.received).toHaveLength(0);
      },
    );
  });

  it('default submit: a GET login form and a cross-origin form action are refused after fill (nothing sent)', async () => {
    for (const path of ['/login-get', '/login-xorigin']) {
      const { eng } = await engine();
      sites.received.length = 0;
      await expect(eng.fill({ item: 'plain', url: good(path), submit: true })).rejects.toThrow(/unsafe form/);
      expect(sites.received).toHaveLength(0);
    }
  });

  it('discover plans without reading a secret or touching the page', async () => {
    const { eng, act } = await engine();
    const d = keep(await eng.discover({ item: 'ruled', url: good('/multi'), submit: true }));
    expect(d).toMatchObject({
      status: 'planned',
      rule_id: 'main',
      fields: ['username', 'password'],
      submit_validated: true,
      secrets_read: false,
    });
    expect(act.policy.locked).toBe(false);
    expect(await page.inputValue('#p')).toBe('');
  });

  it('diagnose is structural: counts and paths, no values, no raw attributes', async () => {
    const { eng } = await engine();
    await page.goto(good('/multi'));
    await page.fill('#u', 'TYPED-VISIBLE-VALUE');
    const d = keep(await eng.diagnose({ item: 'ruled', rule: 'main' })) as {
      diagnostics: { mapping: { fields: { matches: number }[] }; controls: unknown[] };
    };
    const text = JSON.stringify(d);
    expect(text).not.toContain('TYPED-VISIBLE-VALUE');
    expect(text).not.toContain('a1'); // raw name attributes are not exported
    expect(d.diagnostics.mapping.fields.map((f) => f.matches)).toEqual([1, 1]);
    expect(d.diagnostics.controls.length).toBeGreaterThan(3);
  });

  it('pages and verify: origin+path only; evidence booleans; verify works after the lock', async () => {
    const { eng, act } = await engine();
    await eng.fill({
      item: 'ruled',
      url: good('/multi?token=SECRET-QS'),
      submit: true,
      expect: { urlIncludes: '/home' },
    });
    const pages = keep(eng.pages()) as { pages: { origin: string; path: string }[] };
    expect(pages.pages[0]).toMatchObject({ origin: goodOrigin(), path: '/home' });
    expect(JSON.stringify(pages)).not.toContain('SECRET-QS');
    expect(act.policy.locked).toBe(true);
    const v = keep(await eng.verify({ success: '#welcome', failure: '#error' }));
    expect(v).toMatchObject({ login_outcome: 'success', identity_verified: false });
    await expect(eng.verify({ success: 'p:has-text("x")' })).rejects.toMatchObject({ code: 'POLICY' });
    await expect(eng.diagnose({ item: 'ruled' })).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    await expect(eng.discover({ item: 'ruled' })).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
  });
});

describe('registration', () => {
  it('fill-only by default: password and a SEPARATE confirmation field get the same stored value, nothing submitted', async () => {
    const { eng, act } = await engine();
    const r = keep(await eng.register({ item: 'reg', url: good('/register'), rule: 'signup' }));
    expect(r).toMatchObject({ submitted: false, registration_outcome: 'not_submitted', locked: true });
    expect(r.filled).toEqual(['username', 'password', 'confirm_password']);
    expect(sites.received).toHaveLength(0);
    expect(act.policy.locked).toBe(true);
    // equality checked in-page, as a boolean
    expect(
      await page.evaluate(
        () =>
          (document.getElementById('pw1') as HTMLInputElement).value ===
          (document.getElementById('pw2') as HTMLInputElement).value,
      ),
    ).toBe(true);
  });

  it('submit=true: one submit with both fields equal; outcome only from evidence', async () => {
    const { eng } = await engine();
    const r = keep(
      await eng.register({
        item: 'reg',
        url: good('/register'),
        rule: 'signup',
        submit: true,
        expect: { urlIncludes: '/home' },
      }),
    );
    expect(r).toMatchObject({ submitted: true, registration_outcome: 'success' });
    expect(sites.received).toHaveLength(1);
    expect(sites.received[0].fields).toMatchObject({ login: CANARY_USER, password: CANARY, confirm: CANARY });
    const { eng: e2 } = await engine();
    const u = keep(await e2.register({ item: 'reg', url: good('/register'), rule: 'signup', submit: true }));
    expect(u.registration_outcome).toBe('unknown');
  });

  it('requires opt-in (blindfill.registration=allow) and an explicit rule; never inferred', async () => {
    const { eng } = await engine();
    await expect(eng.register({ item: 'reg-noopt', url: good('/register'), rule: 'signup' })).rejects.toThrow(
      /opted in/,
    );
    await expect(
      eng.register({ item: 'reg', url: good('/register'), rule: undefined as never }),
    ).rejects.toThrow(/explicit rule/);
    await expect(eng.register({ item: 'plain', url: good('/register'), rule: 'signup' })).rejects.toThrow(
      /opted in/,
    );
    await expect(eng.register({ item: 'reg', url: good('/register'), rule: 'nope' })).rejects.toThrow(
      /unknown rule/,
    );
    // a login rule cannot be used for registration and vice versa
    await expect(eng.register({ item: 'ruled', url: good('/multi'), rule: 'main' })).rejects.toThrow(
      /opted in/,
    );
    await expect(eng.fill({ item: 'reg', url: good('/register'), rule: 'signup' })).rejects.toThrow(
      /registration rule, not login/,
    );
  });

  it('form-action leaving the origin, GET forms and extra password fields are refused before anything is typed', async () => {
    for (const [path, re] of [
      ['/register-xorigin', /form action leaves/],
      ['/register-get', /GET form/],
      ['/register-extra-pw', /different number of password fields/],
    ] as const) {
      const { eng } = await engine();
      sites.received.length = 0;
      await expect(
        eng.register({ item: 'reg', url: good(path), rule: 'signup', submit: true }),
      ).rejects.toThrow(re);
      expect(sites.received).toHaveLength(0);
      expect(await page.inputValue('#pw1')).toBe('');
    }
  });

  it('a page that corrupts the confirmation field: mismatch detected, nothing submitted', async () => {
    const { eng } = await engine();
    await expect(
      eng.register({ item: 'reg', url: good('/register-nocopy'), rule: 'signup', submit: true }),
    ).rejects.toBeTruthy();
    expect(sites.received).toHaveLength(0);
  });

  it('item password policy is enforced before typing', async () => {
    const { eng } = await engine();
    await expect(
      eng.register({ item: 'reg-policy', url: good('/register'), rule: 'signup' }),
    ).rejects.toThrow(/password policy/);
    expect(await page.inputValue('#pw1')).toBe('');
  });

  it('a form without confirmation (password_confirmation: absent) fills only the password', async () => {
    const { eng } = await engine();
    // /register has two password fields, so the structural check refuses an "absent" rule
    await expect(eng.register({ item: 'reg-absent', url: good('/register'), rule: 'one' })).rejects.toThrow(
      /different number of password fields/,
    );
  });
});

describe('profiles', () => {
  const dirp = () => join(dir, 'cfg', 'profiles');

  it('create is exclusive, private (0600), validates, and exposes a revision', () => {
    const doc = { version: 1, item: 'ruled', web: { origin: goodOrigin(), rule: 'main', submit: false } };
    const { path, profile } = createProfile('p1', doc);
    expect(path).toBe(join(dirp(), 'p1.json'));
    expect(profile.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(() => createProfile('p1', doc)).toThrow(/already exists/);
    expect(loadProfile('p1').revision).toBe(profile.revision);
    expect(() => validateProfile({ ...doc, extra: 1 })).toThrow(/unknown key/);
    expect(() => validateProfile({ ...doc, web: { ...doc.web, origin: `${goodOrigin()}/x?y` } })).toThrow();
    expect(() =>
      validateProfile({
        ...doc,
        web: { ...doc.web, rule: { ...(doc.web as object), id: 'x', mode: 'registration' } },
      }),
    ).toThrow();
  });

  it('loader refuses group-readable files, symlinks and duplicate keys', () => {
    createProfile('p2', { version: 1, item: 'ruled', web: { origin: goodOrigin(), rule: 'main' } });
    chmodSync(join(dirp(), 'p2.json'), 0o640);
    expect(() => loadProfile('p2')).toThrow(/private regular file/);
    chmodSync(join(dirp(), 'p2.json'), 0o600);
    writeFileSync(join(dirp(), 'dup.json'), '{"version":1,"version":1,"item":"x","web":{}}', { mode: 0o600 });
    expect(() => loadProfile('dup')).toThrow(/duplicate/);
    expect(() => loadProfile('../etc')).toThrow();
    expect(() => loadProfile('missing')).toThrow(/not found/);
  });

  it('runProfile: check plans, fill runs the guarded engine on the one matching open page, no navigation', async () => {
    const { eng } = await engine();
    createProfile('p3', {
      version: 1,
      item: 'ruled',
      item_name: 'Fake ruled',
      web: { origin: goodOrigin(), rule: 'main', submit: false },
    });
    const prof = loadProfile('p3');
    await expect(eng.runProfile(prof, { check: true })).rejects.toMatchObject({ code: 'NOT_FOUND' }); // blank page: not navigated for us
    await page.goto(good('/multi'));
    const c = keep(await eng.runProfile(prof, { check: true }));
    expect(c).toMatchObject({ status: 'planned', profile: 'p3', revision: prof.revision });
    const f = keep(await eng.runProfile(prof, { submit: true, expect: { urlIncludes: '/home' } }));
    expect(f).toMatchObject({ submitted: true, outcome: 'success', profile: 'p3' });
    expect(sites.received[0].fields.a2).toBe(CANARY);
  });

  it('a recipe cannot widen authority: item that does not bind the origin / changed name / ambiguous pages', async () => {
    const { eng } = await engine();
    await page.goto(good('/multi'));
    const evil = `http://evil.localhost:${sites.port}`;
    const p = validateProfile(
      { version: 1, item: 'ruled', web: { origin: goodOrigin(), rule: 'main' } },
      'x',
    );
    const widened = validateProfile(
      {
        version: 1,
        item: 'ruled',
        web: {
          origin: evil,
          rule: { id: 'e', top_origin: evil, form: 'form', fields: { password: 'input' } },
        },
      },
      'y',
    );
    await page.goto(sites.url('evil.localhost', '/simple'));
    await expect(eng.runProfile(widened, { check: true })).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
    const renamed = validateProfile(
      { version: 1, item: 'ruled', item_name: 'Another name', web: { origin: goodOrigin(), rule: 'main' } },
      'z',
    );
    await page.goto(good('/multi'));
    await expect(eng.runProfile(renamed, { check: true })).rejects.toThrow(/item_changed/);
    await page
      .context()
      .newPage()
      .then((pg) => pg.goto(good('/multi')));
    await expect(eng.runProfile(p, { check: true })).rejects.toMatchObject({ code: 'AMBIGUOUS' });
    expect((await eng.runProfile(p, { check: true, page: 0 })) as object).toMatchObject({
      status: 'planned',
    });
  });
});
