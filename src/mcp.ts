#!/usr/bin/env node
import './harden.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createBackend, unverifiedNotice } from './backends/registry.js';
import { Engine } from './engine.js';
import { globalScrubber } from './core/scrubber.js';
import { audit } from './core/audit.js';
import { attach, loadSession, stopSession } from './actuators/web/session.js';
import { WebActuator } from './actuators/web/web.js';
import { SessionPolicy } from './core/policy.js';
import type { BlindfillError } from './core/types.js';

const CONTRACT =
  'Blindfill contract: secret-class fields (password, TOTP seed, hidden fields, card numbers, keys) are write-only. ' +
  'They can be filled into a page but are never returned by any tool. Readable fields (username, URIs, text fields, field names) ' +
  "and the current TOTP code are returned normally. Fills are bound to the item's vault URIs, not to anything you pass. " +
  'After a secret fill the session is locked: probe/candidates are refused until session_stop. Fills and submits are one-shot; unknown outcomes are never retried.';

let engine: Engine | null = null;
let ownedActuator: WebActuator | null = null;

async function getEngine(): Promise<Engine> {
  if (engine) return engine;
  const cfg = loadConfig();
  const backend = createBackend(cfg.backend ?? 'bw', cfg);
  const n = unverifiedNotice(backend);
  if (n) process.stderr.write(n + '\n');
  if (cfg.web?.cdp || loadSession()) {
    const { actuator, persist } = await attach({ cdp: cfg.web?.cdp });
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
  return { content: [{ type: 'text', text: globalScrubber.scrub(JSON.stringify(o, null, 2)) }], isError };
}
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return reply(await fn());
  } catch (e) {
    const be = e as BlindfillError & { candidates?: unknown };
    return reply(
      {
        ok: false,
        error: { code: be.code ?? 'ERROR', message: String(be.message) },
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

  server.registerTool(
    'probe',
    {
      description: `Describe the form fields of the current page (structure only: names, types, labels; never values) and list vault items bound to this origin. ${CONTRACT}`,
      inputSchema: {},
    },
    () => run(async () => (await getEngine()).probe()),
  );
  server.registerTool(
    'candidates',
    {
      description: `List candidate input fields (names only, no values). Refused after a secret fill. ${CONTRACT}`,
      inputSchema: { role: z.enum(['username', 'password', 'totp']).optional() },
    },
    ({ role }) => run(async () => (await getEngine()).candidates(role)),
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
        expect: expectShape,
      },
    },
    (a) => run(async () => (await getEngine()).fill(a)),
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
