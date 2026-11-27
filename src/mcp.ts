#!/usr/bin/env node
import './harden.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { attachSettings, loadConfig } from './config.js';
import { createBackend, unverifiedNotice } from './backends/registry.js';
import { Engine } from './engine.js';
import { globalScrubber } from './core/scrubber.js';
import { audit } from './core/audit.js';
import { attach, loadSession, stopSession } from './actuators/web/session.js';
import { WebActuator } from './actuators/web/web.js';
import { SessionPolicy } from './core/policy.js';
import { BlindfillError } from './core/types.js';
import { assertRevision, loadProfile } from './profiles.js';

const CONTRACT =
  'Blindfill contract: secret-class fields (password, TOTP seed, hidden fields, card numbers, keys) are write-only. ' +
  'They can be filled into a page but are never returned by any tool. Readable fields (username, URIs, text fields, field names) ' +
  "and the current TOTP code are returned normally. Fills are bound to the item's vault URIs, not to anything you pass. " +
  'After a secret fill the session is locked: probe/candidates are refused until session_stop. Fills and submits are one-shot; unknown outcomes are never retried.';

let engine: Engine | null = null;
let ownedActuator: WebActuator | null = null;

async function getEngine(): Promise<Engine> {
  if (engine && ownedActuator) return engine;
  // attached session: re-attach per call so a lock or handoff written by another process (CLI) applies
  if (engine) await engine.stop();
  engine = null;
  const cfg = loadConfig();
  const backend = createBackend(cfg.backend ?? 'bw', cfg);
  const n = unverifiedNotice(backend);
  if (n) process.stderr.write(n + '\n');
  const aset = attachSettings(cfg);
  if (aset.endpoint || aset.endpointFile || loadSession()) {
    const { actuator, persist } = await attach(aset);
    engine = new Engine(backend, actuator, persist);
  } else {
    ownedActuator = await WebActuator.launch({
      headless: cfg.web?.headless ?? true,
      executablePath: cfg.web?.executablePath,
      policy: new SessionPolicy(),
    });
    engine = new Engine(backend, ownedActuator);
  }
  return engine;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
function reply(o: unknown, isError = false): ToolResult {
  const text = JSON.stringify(o, null, 2);
  const safe = globalScrubber.guard(text, JSON.stringify({ ok: false, error: { code: 'WITHHELD' } }));
  return { content: [{ type: 'text', text: safe }], isError: isError || safe !== text };
}
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return reply(await fn());
  } catch (e) {
    // only our own errors carry a message; anything else (Playwright, Node, backends) is a fixed code
    if (!(e instanceof BlindfillError)) return reply({ ok: false, error: { code: 'INTERNAL' } }, true);
    const be = e as BlindfillError & { candidates?: unknown };
    return reply(
      {
        ok: false,
        error: { code: be.code, message: String(be.message) },
        candidates: be.candidates,
      },
      true,
    );
  }
}

const itemSel = {
  item: z.string().optional().describe('Backend item id (preferred).'),
  query: z.string().optional().describe('Search text; must match exactly one item.'),
};
const urlArg = z
  .string()
  .optional()
  .describe('Navigate here first (http/https only), then inspect. Without it the current page is used.');
const expectShape = z
  .object({
    urlIncludes: z.string().optional().describe('Success if the final URL (origin+path) contains this.'),
    selector: z
      .string()
      .optional()
      .describe('Success if this element becomes visible (structural CSS only).'),
    failSelector: z
      .string()
      .optional()
      .describe('Failure if this element becomes visible (structural CSS only).'),
    timeoutMs: z.number().int().positive().max(30000).optional(),
  })
  .optional()
  .describe('Evidence used to report the outcome. Without it the outcome is "unknown".');

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'blindfill', version: '0.1.0-alpha.0' });
  // Every error the SDK's tool dispatch catches (schema validation, unknown tool, a throwing handler) ends
  // in createToolError(message); its messages can echo arguments, so they become one fixed code.
  const sdk = server as unknown as { createToolError: (message: string) => ToolResult }; // private in the SDK typings
  if (typeof sdk.createToolError !== 'function') throw new Error('MCP SDK changed: createToolError is gone');
  sdk.createToolError = () => reply({ ok: false, error: { code: 'INVALID_REQUEST' } }, true);

  server.registerTool(
    'probe',
    {
      description: `Describe the form fields of the current page (structure only: names, types, labels; never values) and list vault items bound to this origin. ${CONTRACT}`,
      inputSchema: { url: urlArg },
    },
    ({ url }) => run(async () => (await getEngine()).probe(url)),
  );
  server.registerTool(
    'candidates',
    {
      description: `List candidate input fields (names only, no values). Refused after a secret fill. ${CONTRACT}`,
      inputSchema: { role: z.enum(['username', 'password', 'totp']).optional(), url: urlArg },
    },
    ({ role, url }) => run(async () => (await getEngine()).candidates(role, url)),
  );
  server.registerTool(
    'item_show',
    {
      description: `Show a vault item: readable fields with values, and the NAMES of secret fields (their values are never shown). ${CONTRACT}`,
      inputSchema: itemSel,
    },
    ({ item, query }) => run(async () => (await getEngine()).itemShow({ item, query })),
  );
  server.registerTool(
    'list_credentials',
    {
      description: `List vault items (at most 100): id, name, bound origins, field NAMES and whether the item has rules. No value of any field, no notes, no TOTP code. Same output as the CLI "item list". ${CONTRACT}`,
      inputSchema: { query: z.string().optional().describe('Search text; without it every item is listed.') },
    },
    ({ query }) => run(async () => (await getEngine()).itemList(query ?? '')),
  );
  server.registerTool(
    'profile_login',
    {
      description: `Run a local login recipe (profile) on the one already-open page whose origin matches it; no navigation. Profiles are private local files a person creates with "blindfill profile init"; this tool cannot create or change them, and the recipe grants no authority beyond the item's own URIs. check=true plans only, diagnose=true returns value-free diagnostics. Submits only with submit=true (default false), at most once, never retried. ${CONTRACT}`,
      inputSchema: {
        name: z.string().describe('Profile name.'),
        check: z.boolean().optional().describe('Plan only: no secret read, no field touched.'),
        diagnose: z.boolean().optional().describe('Value-free structural diagnosis of the recipe page.'),
        submit: z.boolean().optional().describe('Submit once after filling (default false).'),
        page: z.number().int().min(0).optional().describe('Page index (list_pages) when several pages match.'),
        revision: z
          .string()
          .optional()
          .describe('Reviewed profile revision; refused if the recipe changed since.'),
        expect: expectShape,
      },
    },
    ({ name, revision, submit, ...opts }) =>
      run(async () => {
        const p = loadProfile(name);
        assertRevision(p, revision);
        return (await getEngine()).runProfile(p, { ...opts, submit: submit ?? false });
      }),
  );
  server.registerTool(
    'totp_code',
    {
      description: `Return the current TOTP code of an item (a short-lived, readable value). The TOTP seed is never returned. ${CONTRACT}`,
      inputSchema: itemSel,
    },
    ({ item, query }) => run(async () => (await getEngine()).totpCode({ item, query })),
  );
  server.registerTool(
    'fill',
    {
      description: `Fill fields of the current page from a vault item (default fields: username, password) and optionally submit once. The secret is written straight into the page; you will not receive it. Refused if the page origin is not bound by the item. Locks the session after a secret fill. ${CONTRACT}`,
      inputSchema: {
        ...itemSel,
        fields: z
          .array(z.string())
          .optional()
          .describe('Field names: username, password, totp, or other item field names.'),
        url: z
          .string()
          .optional()
          .describe('Navigate here first. The binding is checked against where the browser ends up.'),
        submit: z.boolean().optional().describe('Submit once after filling (default false).'),
        rule: z
          .string()
          .optional()
          .describe('Explicit field-rule id from the item rules (chosen by origin when omitted).'),
        expect: expectShape,
      },
    },
    (a) => run(async () => (await getEngine()).fill(a)),
  );
  server.registerTool(
    'human_handoff',
    {
      description: `Hand the browser to a human (CAPTCHA, consent screen, push-MFA) or take it back. action=pause stops every agent-driven browser action until action=resume; status shows the state. You only ever see origin+path of open pages; resume does not clear the post-fill lock. ${CONTRACT}`,
      inputSchema: {
        action: z.enum(['pause', 'resume', 'status']),
        reason: z.enum(['captcha', 'consent', 'mfa', 'other']).optional().describe('Required for pause.'),
      },
    },
    ({ action, reason }) =>
      run(async () => {
        const e = await getEngine();
        return action === 'pause'
          ? e.handoffPause(reason ?? 'other')
          : action === 'resume'
            ? e.handoffResume()
            : e.handoffStatus();
      }),
  );
  server.registerTool(
    'list_pages',
    {
      description: `List the open pages of the attached browser context as origin + path only (no query, no titles, no values). ${CONTRACT}`,
      inputSchema: {},
    },
    () => run(async () => (await getEngine()).pages()),
  );
  server.registerTool(
    'discover_fields',
    {
      description: `Plan a fill without doing it: which item fields and rule would be used on this page. Reads no secret and touches no field. Refused after a secret fill. ${CONTRACT}`,
      inputSchema: {
        ...itemSel,
        url: urlArg,
        rule: z.string().optional(),
        registration: z.boolean().optional().describe('Plan a registration rule instead of a login.'),
        submit: z.boolean().optional().describe('Also validate that the rule submit control is usable.'),
      },
    },
    (a) => run(async () => (await getEngine()).discover(a)),
  );
  server.registerTool(
    'diagnose_fields',
    {
      description: `Structural, value-free diagnosis of the page (counts, tags, types, DOM paths; never values or raw attributes) and of the rule mapping when a rule is given. Refused after a secret fill. ${CONTRACT}`,
      inputSchema: { ...itemSel, url: urlArg, rule: z.string().optional() },
    },
    (a) => run(async () => (await getEngine()).diagnose(a)),
  );
  server.registerTool(
    'verify_login',
    {
      description: `Report whether caller-supplied page evidence (CSS selectors) is visible: success/failure booleans only. It proves nothing about identity. Allowed after the lock. ${CONTRACT}`,
      inputSchema: {
        success: z.string().describe('Structural CSS selector that is visible when logged in.'),
        failure: z.string().optional().describe('Structural CSS selector visible on failure.'),
      },
    },
    (a) => run(async () => (await getEngine()).verify(a)),
  );
  server.registerTool(
    'register_credentials',
    {
      description: `Fill an account-registration form using the stored password of an item that opted in (custom field blindfill.registration=allow) and an explicit registration rule. The same stored value is typed into the password and confirmation fields; nothing is returned. Fill-only unless submit=true; at most one submit; never retried. ${CONTRACT}`,
      inputSchema: {
        ...itemSel,
        rule: z.string().describe('Registration rule id (required; never inferred).'),
        url: z.string().optional(),
        submit: z.boolean().optional(),
        expect: expectShape,
      },
    },
    (a) => run(async () => (await getEngine()).register(a)),
  );
  server.registerTool(
    'fill_totp',
    {
      description: `Fetch the current TOTP code and type it into the page's one-time-code field; optionally submit once. ${CONTRACT}`,
      inputSchema: {
        ...itemSel,
        url: z.string().optional(),
        submit: z.boolean().optional(),
        expect: expectShape,
      },
    },
    (a) => run(async () => (await getEngine()).fillTotp(a)),
  );
  server.registerTool(
    'passkey_sign',
    {
      description: `Sign in with the item's passkey (Chromium only). The item must bind this page and its rpId must cover the host; the private key goes to a temporary browser authenticator and is never returned. Pass click (structural CSS) for the page's passkey button; answered at most once. ${CONTRACT}`,
      inputSchema: {
        ...itemSel,
        url: urlArg,
        click: z
          .string()
          .optional()
          .describe('Button that starts the page passkey sign-in (structural CSS).'),
        expect: expectShape,
      },
    },
    (a) => run(async () => (await getEngine()).passkey(a)),
  );
  server.registerTool(
    'android_offer',
    {
      description: `Arm the blindfill companion APK on an adb-attached phone for one fill. kind=password: the app on screen gets a "blindfill: <item>" autofill suggestion; kind=passkey: the app's passkey request gets a blindfill entry. The phone reports the requesting app's package and signer; the item must bind both (androidapp:// URI + blindfill.signers) or nothing is sent. Waits up to timeout_s for the phone. ${CONTRACT}`,
      inputSchema: {
        ...itemSel,
        serial: z.string().describe('adb device serial'),
        kind: z.enum(['password', 'passkey']),
        timeout_s: z.number().int().min(5).max(300).optional(),
      },
    },
    ({ timeout_s, ...a }) =>
      run(async () =>
        (await getEngine()).androidOffer({ ...a, timeoutMs: timeout_s ? timeout_s * 1000 : undefined }),
      ),
  );
  server.registerTool(
    'session_stop',
    {
      description: `Stop the browser session and clear the post-fill lock and one-shot counters. ${CONTRACT}`,
      inputSchema: {},
    },
    () =>
      run(async () => {
        if (engine) await engine.stop();
        engine = null;
        ownedActuator = null;
        const r = await stopSession();
        audit({ event: 'session', outcome: 'stopped' });
        return { ...r, locked: false };
      }),
  );
  return server;
}

export async function startMcp() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write('blindfill MCP server ready (stdio)\n');
  const bye = async () => {
    await engine?.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  void ownedActuator;
}

if (process.argv[1] && /mcp\.(js|ts)$/.test(process.argv[1])) {
  startMcp().catch((e) => {
    process.stderr.write(globalScrubber.scrub(String(e?.message ?? e)) + '\n');
    process.exit(1);
  });
}
