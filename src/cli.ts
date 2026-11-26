#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { BACKEND_INFO, createBackend, unverifiedNotice } from './backends/registry.js';
import { runSelftest } from './backends/selftest.js';
import { Engine, type FillRequest } from './engine.js';
import { globalScrubber } from './core/scrubber.js';
import { audit } from './core/audit.js';
import { BlindfillError } from './core/types.js';
import { attach, loadSession, startSession, stopSession } from './actuators/web/session.js';
import type { Expect } from './actuators/web/web.js';

// Playwright's DEBUG logging can echo call arguments. Never inherit it.
delete process.env.DEBUG;

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
  totp [--fill]               print the current TOTP code, or fill it into the page
  probe                       describe the current page's form fields (structure only)
  candidates [--role r]       list field candidates (names only)
  backend list                list backends and their support tier
  backend selftest [id]       round-trip a fake item through a backend (--fixture for offline)
  session start|stop|status   manage the local Chromium session

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
    backend: { type: 'string' },
    role: { type: 'string' },
    'expect-url': { type: 'string' },
    'expect-selector': { type: 'string' },
    'fail-selector': { type: 'string' },
    'expect-timeout': { type: 'string' },
    submit: { type: 'boolean' },
    'no-submit': { type: 'boolean' },
    fill: { type: 'boolean' },
    headless: { type: 'boolean' },
    headed: { type: 'boolean' },
    fixture: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

function out(o: unknown): void {
  process.stdout.write(globalScrubber.scrub(JSON.stringify(o, null, 2)) + '\n');
}
function note(s: string): void {
  process.stderr.write(globalScrubber.scrub(s) + '\n');
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
  const cdp = (values.cdp as string | undefined) ?? cfg.web?.cdp;
  const { actuator, persist } = await attach({ cdp });
  return new Engine(backend, actuator, persist);
}

function fillRequest(): FillRequest {
  return {
    item: values.item as string | undefined,
    query: values.query as string | undefined,
    fields: values.fields ? String(values.fields).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    url: values.url as string | undefined,
    submit: values.submit === true && values['no-submit'] !== true,
    expect: expectSpec(),
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
    case 'backend': {
      if (sub === 'list') {
        out(BACKEND_INFO.map((b) => ({ id: b.id, tier: b.tier, title: b.title, binary: b.binary, doc: b.doc })));
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
        const headless = values.headed ? false : ((values.headless as boolean | undefined) ?? cfg.web?.headless ?? true);
        const s = await startSession({ headless, executablePath: cfg.web?.executablePath });
        audit({ event: 'session', outcome: 'started' });
        out({ started: true, cdp: s.cdp, headless });
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
        out(s ? { running: true, cdp: s.cdp, locked: s.policy.locked, owned: s.owned } : { running: false });
        return 0;
      }
      throw new BlindfillError('POLICY', 'usage: blindfill session start|stop|status');
    }
    case 'item': {
      if (sub !== 'show') throw new BlindfillError('POLICY', 'usage: blindfill item show --item <id>');
      const e = await engineFor(false);
      out(await e.itemShow({ item: values.item as string | undefined, query: values.query as string | undefined }));
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
      out(await e.totpCode({ item: values.item as string | undefined, query: values.query as string | undefined }));
      return 0;
    }
    case 'probe':
    case 'candidates': {
      const e = await engineFor(true);
      const r = cmd === 'probe' ? await e.probe() : await e.candidates(values.role as 'username' | 'password' | 'totp' | undefined);
      await disconnect(e);
      out(r);
      return 0;
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
      if (!loadSession() && !values.cdp && !loadConfig().web?.cdp) {
        const cfg = loadConfig();
        const s = await startSession({
          headless: values.headed ? false : ((values.headless as boolean | undefined) ?? cfg.web?.headless ?? true),
          executablePath: cfg.web?.executablePath,
        });
        note(`blindfill: started a browser session (${s.cdp}); stop it with: blindfill session stop`);
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

/** Disconnect from a CDP-attached browser without closing it. */
async function disconnect(e: Engine): Promise<void> {
  await e.stop();
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const be = err as BlindfillError & { candidates?: unknown };
    const code = be?.code ?? 'ERROR';
    const message = String(be?.message ?? err);
    out({ ok: false, error: { code, message }, candidates: be?.candidates });
    note(`blindfill: ${code}: ${message}`);
    process.exit(1);
  });
