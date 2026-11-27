#!/usr/bin/env node
import './harden.js';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { attachSettings, loadConfig } from './config.js';
import { BACKEND_INFO, createBackend, unverifiedNotice } from './backends/registry.js';
import { runSelftest } from './backends/selftest.js';
import { Engine, type FillRequest } from './engine.js';
import { globalScrubber } from './core/scrubber.js';
import { audit } from './core/audit.js';
import { BlindfillError } from './core/types.js';
import { attach, attachSession, loadSession, startSession, stopSession } from './actuators/web/session.js';
import { redactEndpoint, resolveEndpoint } from './actuators/web/providers/util.js';
import type { Expect } from './actuators/web/web.js';
import { strictJson } from './rules.js';
import { assertRevision, createProfile, loadProfile, type ProfileDoc } from './profiles.js';
import { AndroidActuator, COMPANION, COMPANION_SERVICES } from './actuators/android/index.js';

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
})();

const HELP = `blindfill ${VERSION}: let AI agents sign in without ever seeing the password.

Usage: blindfill <command> [options]        (JSON on stdout, diagnostics on stderr)

Commands:
  login <url|web:origin>      open the page, pick the bound item, fill username+password, submit once
  fill                        fill fields on the current page (--fields username,password,totp,<name>)
  item show                   show an item: readable fields only (secret field NAMES, never values)
  item list [text]            list items (names, origins, field names); item status <id> structural status
  item rename <id> <name>     rename; item edit <id> [--origin o ...] [--username u] [--set N=V] [--unset N] [--secret N]
                              (origins, blindfill.* and --secret need a terminal; there is deliberately no reveal)
  item generate <name>        generate a password (CSPRNG, optional --policy-file) and save it as a new item; never printed
  item create [name]          create an item; username/password are read from the terminal (hidden)
  item password-policy <id>   read, or replace with --policy-file, the item's non-secret password policy
  passkey --click <css>       sign in with the item's passkey: Chromium only; the page's WebAuthn request is answered once
  android fill|passkey        arm the companion APK on --serial <adb serial> for one fill of --item (app must be bound
                              by androidapp:// + blindfill.signers); waits --timeout seconds (default 60)
  android install             install the packaged companion APK on --serial (adb install -r); --set-services also
                              makes it the autofill and credential provider (prints the previous values to restore)
  totp [--fill]               print the current TOTP code, or fill it into the page
  probe                       describe the current page's form fields (structure only)
  candidates [--role r]       list field candidates (names only)
  backend list                list backends and their support tier
  backend selftest [id]       round-trip a fake item through a backend (--fixture for offline)
  handoff pause|resume|status hand the browser to a person (CAPTCHA/consent/MFA); agent actions are refused meanwhile
  register --rule <id>        fill a registration form from an opted-in item (fill-only unless --submit)
  page list|discover|diagnose|verify
                              open pages (origin+path), planned fields, structural diagnosis, outcome evidence
  profile init|validate|login login recipes: init <name> --item id --origin o --rule id; validate <name>;
                              login <name> [--check|--diagnose] [--submit] [--page n] [--revision sha]
  session start|stop|status   manage the local Chromium session
  mcp                         run the MCP server on stdio

Options:
  --item <id>        backend item id            --query <text>   search text (must match one item)
  --fields a,b       fields to fill             --url <url>      navigate first
  --submit / --no-submit                         --cdp <url>      attach to a loopback CDP endpoint
  --expect-url <s>   success if URL contains s   --expect-selector <css>  --fail-selector <css>
  --headless         (session start / login)    --backend <id>   override the configured backend
  --fixture          (backend selftest) use the built-in fake runner
  -h, --help   -v, --version

Secrets can be filled but are never printed, returned or logged. See SECURITY.md.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    item: { type: 'string' },
    query: { type: 'string' },
    fields: { type: 'string' },
    url: { type: 'string' },
    cdp: { type: 'string' },
    endpoint: { type: 'string' },
    'endpoint-file': { type: 'string' },
    browser: { type: 'string' },
    page: { type: 'string' },
    rule: { type: 'string' },
    reason: { type: 'string' },
    set: { type: 'string', multiple: true },
    unset: { type: 'string', multiple: true },
    secret: { type: 'string', multiple: true },
    username: { type: 'string' },
    'display-name': { type: 'string' },
    length: { type: 'string' },
    'policy-file': { type: 'string' },
    'no-registration': { type: 'boolean' },
    totp: { type: 'boolean' },
    name: { type: 'string' },
    origin: { type: 'string', multiple: true },
    revision: { type: 'string' },
    'success-selector': { type: 'string' },
    check: { type: 'boolean' },
    diagnose: { type: 'boolean' },
    registration: { type: 'boolean' },
    executable: { type: 'string' },
    backend: { type: 'string' },
    role: { type: 'string' },
    'expect-url': { type: 'string' },
    'expect-selector': { type: 'string' },
    'fail-selector': { type: 'string' },
    click: { type: 'string' },
    serial: { type: 'string' },
    timeout: { type: 'string' },
    'expect-timeout': { type: 'string' },
    submit: { type: 'boolean' },
    'no-submit': { type: 'boolean' },
    fill: { type: 'boolean' },
    headless: { type: 'boolean' },
    headed: { type: 'boolean' },
    'set-services': { type: 'boolean' },
    fixture: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const WITHHELD = 'output withheld: it matched a secret';
function out(o: unknown): void {
  const text = JSON.stringify(o, null, 2);
  process.stdout.write(
    globalScrubber.guard(
      text,
      JSON.stringify({ ok: false, error: { code: 'WITHHELD', message: WITHHELD } }),
    ) + '\n',
  );
}
function note(s: string): void {
  process.stderr.write(globalScrubber.guard(s, `blindfill: ${WITHHELD}`) + '\n');
}

function expectSpec(): Expect | undefined {
  const e: Expect = {
    urlIncludes: values['expect-url'] as string | undefined,
    selector: values['expect-selector'] as string | undefined,
    failSelector: values['fail-selector'] as string | undefined,
    timeoutMs: values['expect-timeout'] ? Number(values['expect-timeout']) : undefined,
  };
  return e.urlIncludes || e.selector || e.failSelector ? e : undefined;
}

async function engineFor(needBrowser: boolean): Promise<Engine> {
  const cfg = loadConfig();
  const backend = createBackend((values.backend as string) ?? cfg.backend ?? 'bw', cfg);
  const n = unverifiedNotice(backend);
  if (n) note(n);
  if (!needBrowser) return new Engine(backend);
  const { actuator, persist } = await attach(attachSettings(cfg, flagSettings()));
  return new Engine(backend, actuator, persist);
}

function flagSettings() {
  return {
    endpoint: values.endpoint as string | undefined,
    cdp: values.cdp as string | undefined,
    endpointFile: values['endpoint-file'] as string | undefined,
    browser: values.browser as string | undefined,
    page: values.page as string | undefined,
  };
}

function fillRequest(): FillRequest {
  return {
    item: values.item as string | undefined,
    query: values.query as string | undefined,
    fields: values.fields
      ? String(values.fields)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    url: values.url as string | undefined,
    submit: values.submit === true && values['no-submit'] !== true,
    expect: expectSpec(),
    rule: values.rule as string | undefined,
  };
}

async function main(): Promise<number> {
  const [cmd, sub] = positionals;
  if (values.version) {
    out({ version: VERSION });
    return 0;
  }
  if (values.help || !cmd || cmd === 'help') {
    process.stdout.write(HELP);
    return cmd || values.help ? 0 : 1;
  }

  switch (cmd) {
    case 'mcp': {
      const { startMcp } = await import('./mcp.js');
      await startMcp();
      return -1; // keep running
    }
    case 'backend': {
      if (sub === 'list') {
        out(
          BACKEND_INFO.map((b) => ({ id: b.id, tier: b.tier, title: b.title, binary: b.binary, doc: b.doc })),
        );
        return 0;
      }
      if (sub === 'selftest') {
        const id = positionals[2] ?? (values.backend as string) ?? loadConfig().backend ?? 'bw';
        const res = await runSelftest(id, { fixture: values.fixture === true, cfg: loadConfig() });
        out(res);
        return res.result === 'pass' ? 0 : 1;
      }
      throw new BlindfillError('POLICY', 'usage: blindfill backend list|selftest [id]');
    }
    case 'session': {
      if (sub === 'start') {
        const cfg = loadConfig();
        const headless = values.headed
          ? false
          : ((values.headless as boolean | undefined) ?? cfg.web?.headless ?? true);
        const s = await startSession({
          headless,
          executablePath: (values.executable as string | undefined) ?? cfg.web?.executablePath,
        });
        audit({ event: 'session', outcome: 'started' });
        out({ started: true, browser: s.browser, endpoint: s.cdp, cdp: s.cdp, headless });
        return 0;
      }
      if (sub === 'attach') {
        const cfg = loadConfig();
        const a = attachSettings(cfg, flagSettings());
        const r = await attachSession({ ...a });
        audit({ event: 'session', outcome: 'attached' });
        out({ attached: true, ...r, locked: false });
        return 0;
      }
      if (sub === 'stop') {
        const r = await stopSession();
        audit({ event: 'session', outcome: 'stopped' });
        out({ ...r, locked: false });
        return 0;
      }
      if (sub === 'status') {
        const s = loadSession();
        out(
          s
            ? {
                running: true,
                browser: s.browser ?? 'chromium-cdp',
                endpoint: redactEndpoint(
                  resolveEndpoint({ endpoint: s.cdp || undefined, endpointFile: s.endpointFile }),
                ),
                endpointFile: s.endpointFile,
                locked: s.policy.locked,
                paused: s.policy.paused ?? null,
                owned: s.owned,
              }
            : { running: false },
        );
        return 0;
      }
      throw new BlindfillError('POLICY', 'usage: blindfill session start|attach|stop|status');
    }
    case 'item': {
      const origins = (values.origin as string[] | undefined) ?? [];
      const policyFile = values['policy-file'] as string | undefined;
      const policy = policyFile ? strictJson(readFileSync(policyFile, 'utf8')) : undefined;
      if (sub === 'generate') {
        const name = positionals[2];
        if (!name || !values.username)
          throw new BlindfillError(
            'POLICY',
            'usage: blindfill item generate <name> --origin <https origin> [--origin ...] --username <u> [--display-name n] [--length n] [--policy-file f] [--no-registration]',
          );
        const e = await engineFor(false);
        out(
          await e.itemGenerate({
            name,
            origins,
            username: String(values.username),
            displayName: values['display-name'] as string | undefined,
            length: values.length ? Number(values.length) : undefined,
            policy,
            registration: values['no-registration'] === true ? false : true,
          }),
        );
        return 0;
      }
      if (sub === 'create') {
        if (!process.stdin.isTTY || !process.stderr.isTTY)
          throw new BlindfillError(
            'POLICY',
            'item create reads the password from a terminal; use item generate for scripted use',
          );
        const username = String(values.username ?? (await readLine('Username: ')));
        const password = await readHidden('Password: ');
        if (password !== (await readHidden('Confirm password: ')))
          throw new BlindfillError('POLICY', 'the two passwords differ; nothing was saved');
        const seed = values.totp ? await readHidden('TOTP seed: ') : undefined;
        const e = await engineFor(false);
        out(
          await e.itemCreate({
            name: positionals[2],
            origins,
            username,
            password,
            totpSeed: seed || undefined,
            policy,
          }),
        );
        return 0;
      }
      if (sub === 'password-policy') {
        const e = await engineFor(false);
        out(
          await e.itemPasswordPolicy(
            {
              item: (values.item as string | undefined) ?? positionals[2],
              query: values.query as string | undefined,
            },
            policy,
            !!(process.stdin.isTTY && process.stderr.isTTY),
          ),
        );
        return 0;
      }
      const sel = {
        item: (values.item as string | undefined) ?? undefined,
        query: values.query as string | undefined,
      };
      if (sub === 'list') {
        out(await (await engineFor(false)).itemList(positionals[2] ?? ''));
        return 0;
      }
      if (sub === 'status') {
        out(await (await engineFor(false)).itemStatus({ ...sel, item: sel.item ?? positionals[2] }));
        return 0;
      }
      if (sub === 'rename') {
        const [, , a, b2] = positionals;
        const byFlag = !!(sel.item || sel.query);
        const nn = byFlag ? a : b2;
        if (!nn) throw new BlindfillError('POLICY', 'usage: blindfill item rename <item id> <new name>');
        out(await (await engineFor(false)).itemRename(byFlag ? sel : { item: a }, nn));
        return 0;
      }
      if (sub === 'edit') {
        const human = !!(process.stdin.isTTY && process.stderr.isTTY);
        const set: Record<string, string> = {};
        for (const kv of (values.set as string[] | undefined) ?? []) {
          const i = kv.indexOf('=');
          if (i < 1) throw new BlindfillError('POLICY', '--set needs NAME=VALUE');
          set[kv.slice(0, i)] = kv.slice(i + 1);
        }
        const secrets: Record<string, string> = {};
        for (const n of (values.secret as string[] | undefined) ?? []) {
          if (!human) throw new BlindfillError('POLICY', 'secret values are entered at a terminal');
          const v = await readHidden(`New value for ${n}: `);
          if (v !== (await readHidden(`Confirm ${n}: `)))
            throw new BlindfillError('POLICY', 'the two values differ; nothing was saved');
          secrets[n] = v;
        }
        out(
          await (
            await engineFor(false)
          ).itemEdit(
            { ...sel, item: sel.item ?? positionals[2] },
            {
              origins: origins.length ? origins : undefined,
              username: values.username as string | undefined,
              set,
              unset: values.unset as string[] | undefined,
              secrets,
              human,
            },
          ),
        );
        return 0;
      }
      if (sub !== 'show')
        throw new BlindfillError(
          'POLICY',
          'usage: blindfill item show|list|status|rename|edit|generate|create|password-policy',
        );
      const e = await engineFor(false);
      out(
        await e.itemShow({
          item: values.item as string | undefined,
          query: values.query as string | undefined,
        }),
      );
      return 0;
    }
    case 'android': {
      if (sub !== 'fill' && sub !== 'passkey' && sub !== 'install')
        throw new BlindfillError(
          'POLICY',
          'usage: blindfill android fill|passkey --item <id> --serial <adb serial> | android install --serial <adb serial> [--set-services]',
        );
      const serial = (values.serial as string | undefined) ?? process.env.ANDROID_SERIAL;
      if (!serial)
        throw new BlindfillError('POLICY', 'usage: pass --serial <adb serial> (or ANDROID_SERIAL)');
      if (sub === 'install') {
        const setServices = Boolean(values['set-services']);
        const r = await new AndroidActuator().install(serial, setServices);
        const restore = Object.entries(r.previous).map(([k, v]) =>
          v === 'null'
            ? `adb -s ${serial} shell settings delete secure ${k}`
            : `adb -s ${serial} shell settings put secure ${k} ${v === '' ? '\'""\'' : v}`,
        );
        out({
          status: 'installed',
          package: COMPANION,
          apk: r.apk,
          services: setServices ? COMPANION_SERVICES : 'unchanged (pass --set-services to switch them)',
          previous: r.previous,
          restore: setServices ? restore : undefined,
          uninstall: `adb -s ${serial} uninstall ${COMPANION}`,
        });
        return 0;
      }
      const e = await engineFor(false);
      out(
        await e.androidOffer({
          item: values.item as string | undefined,
          query: values.query as string | undefined,
          serial,
          kind: sub === 'passkey' ? 'passkey' : 'password',
          timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
        }),
      );
      return 0;
    }
    case 'passkey': {
      const e = await engineFor(true);
      try {
        out(
          await e.passkey({
            item: values.item as string | undefined,
            query: values.query as string | undefined,
            url: values.url as string | undefined,
            click: values.click as string | undefined,
            expect: expectSpec(),
          }),
        );
      } finally {
        await disconnect(e);
      }
      return 0;
    }
    case 'totp': {
      if (values.fill) {
        const e = await engineFor(true);
        const { fields: _f, ...req } = fillRequest();
        const r = await e.fillTotp(req);
        await disconnect(e);
        out(r);
        return 0;
      }
      const e = await engineFor(false);
      out(
        await e.totpCode({
          item: values.item as string | undefined,
          query: values.query as string | undefined,
        }),
      );
      return 0;
    }
    case 'probe':
    case 'candidates': {
      const e = await engineFor(true);
      const r =
        cmd === 'probe'
          ? await e.probe(values.url as string | undefined)
          : await e.candidates(
              values.role as 'username' | 'password' | 'totp' | undefined,
              values.url as string | undefined,
            );
      await disconnect(e);
      out(r);
      return 0;
    }
    case 'handoff': {
      const e = await engineFor(true);
      try {
        if (sub === 'pause') out(e.handoffPause(String(values.reason ?? 'other')));
        else if (sub === 'resume') out(e.handoffResume());
        else if (sub === 'status') out(e.handoffStatus());
        else
          throw new BlindfillError(
            'POLICY',
            'usage: blindfill handoff pause --reason captcha|consent|mfa|other | resume | status',
          );
      } finally {
        await disconnect(e);
      }
      return 0;
    }
    case 'register': {
      const e = await engineFor(true);
      try {
        const req = fillRequest();
        if (!req.rule) throw new BlindfillError('POLICY', 'register needs --rule <registration rule id>');
        out(await e.register({ ...req, rule: req.rule }));
      } finally {
        await disconnect(e);
      }
      return 0;
    }
    case 'page': {
      if (sub === 'list') {
        const e = await engineFor(true);
        try {
          out(e.pages());
        } finally {
          await disconnect(e);
        }
        return 0;
      }
      if (sub === 'discover' || sub === 'diagnose') {
        const e = await engineFor(true);
        try {
          const req = fillRequest();
          out(
            sub === 'discover'
              ? await e.discover({ ...req, registration: values.registration === true })
              : await e.diagnose({ item: req.item, query: req.query, rule: req.rule, url: req.url }),
          );
        } finally {
          await disconnect(e);
        }
        return 0;
      }
      if (sub === 'verify') {
        const success = values['success-selector'] as string | undefined;
        if (!success)
          throw new BlindfillError(
            'POLICY',
            'usage: blindfill page verify --success-selector <css> [--fail-selector <css>]',
          );
        const e = await engineFor(true);
        try {
          out(await e.verify({ success, failure: values['fail-selector'] as string | undefined }));
        } finally {
          await disconnect(e);
        }
        return 0;
      }
      throw new BlindfillError('POLICY', 'usage: blindfill page list|discover|diagnose|verify');
    }
    case 'profile': {
      const name = positionals[2];
      if (!name) throw new BlindfillError('POLICY', 'usage: blindfill profile init|validate|login <name>');
      if (sub === 'validate') {
        const p = loadProfile(name);
        out({ status: 'valid', name: p.name, revision: p.revision, origin: p.doc.web.origin });
        return 0;
      }
      if (sub === 'init') {
        const item = values.item as string | undefined;
        const origin = (values.origin as string[] | undefined)?.[0];
        const rule = values.rule as string | undefined;
        if (!item || !origin || !rule)
          throw new BlindfillError(
            'POLICY',
            'usage: blindfill profile init <name> --item <id> --origin <origin> --rule <rule id> [--fields a,b] [--submit]',
          );
        const e = await engineFor(false);
        const meta = await e.itemShow({ item });
        const doc: ProfileDoc = {
          version: 1,
          item,
          item_name: meta.name,
          web: {
            origin,
            rule,
            ...(values.fields
              ? {
                  fields: String(values.fields)
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                }
              : {}),
            submit: values.submit === true,
          },
        };
        const { path, profile } = createProfile(name, doc);
        out({ status: 'created', name, path, revision: profile.revision });
        return 0;
      }
      if (sub === 'login') {
        const p = loadProfile(name);
        assertRevision(p, values.revision as string | undefined);
        const e = await engineFor(true);
        try {
          out(
            await e.runProfile(p, {
              check: values.check === true,
              diagnose: values.diagnose === true,
              submit: values.submit === true ? true : values['no-submit'] === true ? false : undefined,
              page:
                values.page !== undefined && /^\d+$/.test(String(values.page))
                  ? Number(values.page)
                  : undefined,
              expect: expectSpec(),
            }),
          );
        } finally {
          await disconnect(e);
        }
        return 0;
      }
      throw new BlindfillError('POLICY', 'usage: blindfill profile init|validate|login <name>');
    }
    case 'fill': {
      const e = await engineFor(true);
      try {
        out(await e.fill(fillRequest()));
      } finally {
        await disconnect(e);
      }
      return 0;
    }
    case 'login': {
      const target = sub;
      if (!target) throw new BlindfillError('POLICY', 'usage: blindfill login <url|web:origin> [--item id]');
      const url = target.startsWith('web:') ? target.slice(4) : target;
      const aset = attachSettings(loadConfig(), flagSettings());
      if (!loadSession() && !aset.endpoint && !aset.endpointFile) {
        const cfg = loadConfig();
        const s = await startSession({
          headless: values.headed
            ? false
            : ((values.headless as boolean | undefined) ?? cfg.web?.headless ?? true),
          executablePath: (values.executable as string | undefined) ?? cfg.web?.executablePath,
        });
        note(
          `blindfill: started a browser session (${redactEndpoint(s.cdp)}); stop it with: blindfill session stop`,
        );
      }
      const e = await engineFor(true);
      try {
        const req = fillRequest();
        out(await e.fill({ ...req, url, submit: values['no-submit'] ? false : true }));
      } finally {
        await disconnect(e);
      }
      return 0;
    }
    default:
      process.stderr.write(HELP);
      return 1;
  }
}

function readLine(prompt: string): Promise<string> {
  return new Promise((res) => {
    process.stderr.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      res(String(d).replace(/\r?\n$/, ''));
    });
  });
}
/** Read without echo (TTY only). The typed value is never printed. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((res, rej) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\u0003') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          process.stderr.write('\n');
          return rej(new BlindfillError('POLICY', 'cancelled'));
        }
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return res(buf);
        }
        if (c === '\u007f') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** Disconnect from a CDP-attached browser without closing it. */
async function disconnect(e: Engine): Promise<void> {
  await e.stop();
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err: unknown) => {
    const be = err as BlindfillError & { candidates?: unknown };
    const code = be?.code ?? 'ERROR';
    const message = String(be?.message ?? err);
    out({ ok: false, error: { code, message }, candidates: be?.candidates });
    note(`blindfill: ${code}: ${message}`);
    process.exit(1);
  });
