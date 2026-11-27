/**
 * `ego-cli` provider (supported since 2026-11-28): drives the user's running Ego Lite through
 * its own `ego-browser nodejs` CLI. Ego Lite exposes no CDP port, so a small script runs inside
 * Ego's Node runtime and serves page operations over a private unix socket (0700 state dir,
 * one client, nonce handshake). The script source never contains a secret; values travel only
 * over that socket. The adapter below mimics the slice of Playwright's Page / Frame /
 * ElementHandle API that WebActuator uses, so every safety check stays in one place.
 *
 * Exception to the provider contract: filled values DO pass through Ego's Node runtime. See
 * docs/browsers.md (Ego Lite) for the leak checks that gate its use.
 *
 * Endpoint: `ego://new` (a fresh task space) or `ego://<space>/<page>` (a space this agent already
 * controls, e.g. `ego://72/p1`).
 *
 * Limits: only frames in the page's own renderer are visible (cross-origin out-of-process
 * iframes are not, so fields inside them are never filled); `page.url()`/`frames()` are served
 * from a cache refreshed every 150 ms. To close that window, every text input re-checks inside
 * Ego, in the same call, that the target element's document still has the origin seen at scan
 * time and that the element holds focus.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { stateDir } from '../../../core/audit.js';
import { BlindfillError } from '../../../core/types.js';
import type { BrowserProvider } from './types.js';

export interface EgoTarget {
  /** an Ego task space this agent already controls; null: a new space is created */
  space: number | null;
  /** page label inside that space (e.g. "p2"); null: the first managed page */
  page: string | null;
}

/** `ego://new` or `ego://<space>/<page>`; anything else is refused. */
export function parseEgoEndpoint(endpoint: string | undefined): EgoTarget {
  if (!endpoint || endpoint === 'ego://new') return { space: null, page: null };
  const m = /^ego:\/\/(\d{1,9})(?:\/(p\d{1,4}))?$/.exec(endpoint);
  if (!m) throw new BlindfillError('ACTUATOR', 'ego-cli endpoint must be ego://new or ego://<space>/<page>');
  return { space: Number(m[1]), page: m[2] ?? null };
}

/** Runs inside Ego's Node runtime. __CFG__ is replaced with JSON (socket path, nonce, target). */
const EGO_SCRIPT = String.raw`
const net = await import("node:net");
const CFG = __CFG__;
let task, owned = false;
if (CFG.space != null) {
  const entry = (await listTaskSpaces()).find((s) => s.id === CFG.space);
  if (!entry) throw new Error("ego task space not found");
  if (entry.ownership !== "agent") throw new Error("ego task space is not under agent control");
  task = await taskSpace(CFG.space);
} else {
  task = await taskSpace("blindfill " + CFG.nonce.slice(0, 6));
  owned = true;
}
const page = CFG.page ? task.page(CFG.page) : (await task.pages())[0];
if (!page) throw new Error("no page in the ego task space");
const cdp = (m, p) => page.cdp(m, p);
const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
};
// One isolated world per frame document, so handles from separate calls can be compared and passed together.
const worlds = new Map();
const world = async (frameId) => {
  if (!worlds.has(frameId))
    worlds.set(frameId, (await cdp("Page.createIsolatedWorld", { frameId, worldName: "blindfill" })).executionContextId);
  return worlds.get(frameId);
};
// Handles inside an argument arrive as {__h: i}; they are passed as extra CDP arguments and put back in place.
const REVIVE = "const rv = (x) => x && typeof x === 'object' ? ('__h' in x ? hs[x.__h] : Array.isArray(x) ? x.map(rv) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rv(v)]))) : x;";
const result = (r, byValue) => {
  if (r.exceptionDetails) throw new Error("EVAL");
  const o = r.result;
  return byValue || !o.objectId ? { v: o.value } : { h: o.objectId, node: o.subtype === "node" };
};
const OPS = {
  url: () => page.url(),
  title: () => page.title(),
  goto: async (u) => { await page.goto(u, { timeout: 20000 }); },
  frames: async () => {
    const out = [];
    const walk = (n, parentId) => {
      out.push({ id: n.frame.id, url: n.frame.url + (n.frame.urlFragment || ""), parentId });
      for (const c of n.childFrames || []) walk(c, n.frame.id);
    };
    walk((await cdp("Page.getFrameTree")).frameTree, null);
    return out;
  },
  // expression in the frame's world; a stale world (the frame navigated) is replaced once
  evalIn: async (frameId, expr, byValue) => {
    for (let i = 0; ; i++) {
      try {
        return result(await cdp("Runtime.evaluate", { expression: expr, contextId: await world(frameId), returnByValue: byValue }), byValue);
      } catch (e) {
        if (i || e.message === "EVAL") throw e;
        worlds.delete(frameId);
      }
    }
  },
  // fn(this, spec) on a handle, or fn(spec) in the frame's world. Only a call without handles may move to a
  // fresh world: handles must stay in theirs, so a navigation makes such a call fail.
  call: async (thisId, frameId, src, spec, hs, byValue) => {
    const self = thisId != null;
    for (let i = 0; ; i++) {
      try {
        const r = await cdp("Runtime.callFunctionOn", {
          ...(self ? { objectId: thisId } : { executionContextId: await world(frameId) }),
          functionDeclaration: "function (spec, ...hs) { " + REVIVE + " return (" + src + ")(" + (self ? "this, " : "") + "rv(spec)); }",
          arguments: [{ value: spec }, ...hs.map((objectId) => ({ objectId }))],
          returnByValue: byValue,
          awaitPromise: true,
        });
        return result(r, byValue);
      } catch (e) {
        if (i || self || hs.length || e.message === "EVAL") throw e;
        worlds.delete(frameId);
      }
    }
  },
  release: async (oid) => { await cdp("Runtime.releaseObject", { objectId: oid }); },
  // the frame id an <iframe> element shows
  contentFrame: async (oid) => (await cdp("DOM.describeNode", { objectId: oid })).node.frameId ?? null,
  queryAll: async (frameId, sel, limit) => {
    const expr = "Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).slice(0, " + Number(limit) + ")";
    const r = await OPS.evalIn(frameId, expr, false).catch(() => { throw new Error("SELECTOR"); });
    const p = await cdp("Runtime.getProperties", { objectId: r.h, ownProperties: true });
    return p.result.filter((x) => /^\d+$/.test(x.name)).sort((a, b) => a.name - b.name).map((x) => x.value.objectId);
  },
  focus: async (oid) => { await cdp("DOM.focus", { objectId: oid }); },
  // Types only if the element's document still has the scanned origin and the element has focus.
  typeInto: async (oid, origin, text, keys) => {
    const ok = await cdp("Runtime.callFunctionOn", {
      objectId: oid,
      functionDeclaration: "function (o) { const r = this.getRootNode(); return this.ownerDocument.location.origin === o && (r.activeElement || this.ownerDocument.activeElement) === this; }",
      arguments: [{ value: origin }],
      returnByValue: true,
    });
    if (ok.result.value !== true) throw new Error("GUARD");
    if (!keys) return void (await cdp("Input.insertText", { text }));
    for (const ch of text) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  },
  key: async (name) => {
    if (name === "SelectAll") {
      const modifiers = process.platform === "darwin" ? 4 : 2; // Meta / Ctrl, as a real shortcut
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers, commands: ["selectAll"] });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers });
      return;
    }
    const k = KEYS[name];
    if (!k) throw new Error("KEY");
    await cdp("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...k });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  },
  click: async (oid) => {
    await cdp("Runtime.callFunctionOn", { objectId: oid, functionDeclaration: "function () { this.scrollIntoView({ block: 'center' }); }" });
    const q = (await cdp("DOM.getBoxModel", { objectId: oid })).model.content;
    const x = (q[0] + q[2] + q[4] + q[6]) / 4, y = (q[1] + q[3] + q[5] + q[7]) / 4;
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  },
  screenshot: async () => (await cdp("Page.captureScreenshot", { format: "png" })).data,
};
// Error text never echoes arguments: they may carry a secret.
const SECRET_OPS = new Set(["typeInto", "call"]);
const sock = net.createConnection(CFG.sock);
let buf = "";
let keep = true;
const closed = new Promise((res) => sock.on("close", res));
sock.on("error", () => {});
sock.write(JSON.stringify({ hello: CFG.nonce }) + "\n");
sock.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.op === "close") { keep = msg.args[0] !== false; sock.end(); continue; }
    Promise.resolve()
      .then(() => OPS[msg.op](...msg.args))
      .then(
        (value) => sock.write(JSON.stringify({ id: msg.id, ok: true, value }) + "\n"),
        (e) => sock.write(JSON.stringify({ id: msg.id, ok: false,
          error: SECRET_OPS.has(msg.op) ? msg.op + " failed" : String((e && e.message) || e).slice(0, 200) }) + "\n"),
      );
  }
});
await closed;
if (owned) await task.finish({ keep: keep ? [page.label] : [] });
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class EgoBridge {
  private seq = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private constructor(
    private sock: Socket,
    private server: Server,
    private child: ChildProcess,
    private sockPath: string,
  ) {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as { id: number; ok: boolean; value?: unknown; error?: string };
        buf = buf.slice(i + 1);
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.ok) p?.res(m.value);
        else p?.rej(new BlindfillError('ACTUATOR', `ego: ${m.error ?? 'failed'}`));
      }
    });
    sock.on('close', () => {
      for (const p of this.pending.values()) p.rej(new BlindfillError('ACTUATOR', 'ego bridge closed'));
      this.pending.clear();
    });
  }

  static async open(
    target: EgoTarget,
    bin = process.env.BLINDFILL_EGO_BIN ?? 'ego-browser',
  ): Promise<EgoBridge> {
    // unix socket in the 0700 state dir; a Windows named pipe has no such protection yet
    if (process.platform === 'win32')
      throw new BlindfillError('ACTUATOR', 'the ego-cli provider is not supported on Windows yet');
    const dir = stateDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nonce = randomBytes(16).toString('hex');
    const sockPath = join(dir, `ego-${nonce.slice(0, 8)}.sock`);
    const server = createServer();
    const accepted = new Promise<Socket>((resolve, reject) => {
      server.on('connection', (s) => {
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString('utf8');
          const i = buf.indexOf('\n');
          if (i < 0) return;
          s.off('data', onData);
          let hello: unknown;
          try {
            hello = (JSON.parse(buf.slice(0, i)) as { hello?: unknown }).hello;
          } catch {
            hello = undefined;
          }
          if (hello !== nonce) return void s.destroy();
          server.close(); // one client only
          resolve(s);
        };
        s.on('data', onData);
      });
      server.on('error', reject);
    });
    await new Promise<void>((r, j) => server.listen(sockPath, r).once('error', j));
    const cfg = JSON.stringify({
      sock: sockPath,
      nonce,
      space: target.space ?? null,
      page: target.page ?? null,
    });
    const child = spawn(bin, ['nodejs'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d.toString('utf8')).slice(-2000));
    child.stdin!.end(EGO_SCRIPT.replace('__CFG__', cfg));
    const failed = new Promise<never>((_, reject) => {
      child.on('error', () =>
        reject(new BlindfillError('ACTUATOR', `cannot run ${bin}; is Ego Lite installed?`)),
      );
      child.on('exit', () =>
        reject(
          new BlindfillError(
            'ACTUATOR',
            `ego-browser exited: ${stderr.trim().split('\n').slice(-3).join(' ')}`,
          ),
        ),
      );
    });
    const timeout = sleep(20_000).then(() => {
      throw new BlindfillError('ACTUATOR', 'ego-browser did not connect within 20 s');
    });
    try {
      const sock = await Promise.race([accepted, failed, timeout]);
      return new EgoBridge(sock, server, child, sockPath);
    } catch (e) {
      child.kill();
      server.close();
      rmSync(sockPath, { force: true });
      throw e;
    }
  }

  call<T>(op: string, ...args: unknown[]): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.sock.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  async close(keepPage: boolean): Promise<void> {
    this.sock.end(JSON.stringify({ id: 0, op: 'close', args: [keepPage] }) + '\n');
    await Promise.race([new Promise((r) => this.child.once('exit', r)), sleep(10_000)]);
    this.server.close();
    rmSync(this.sockPath, { force: true });
  }
}

// ---- Playwright-shaped adapter (only what WebActuator calls) ---------------------------------

const SCROLL = '(el) => el.scrollIntoView({ block: "center" })';
const SELECT = '(el) => { if (typeof el.select === "function") el.select(); }';
const ENABLED = '(el) => !el.matches(":disabled")';
const VISIBLE =
  '(e) => { if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e);' +
  ' return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; }';
const src = (fn: unknown) => (typeof fn === 'function' ? fn.toString() : String(fn));

type FocusState = { focused?: EgoHandle };
type Remote = { v?: unknown; h?: string; node?: boolean };

/** Replace handles inside an argument with {__h: i}; their object ids travel as separate CDP arguments. */
function pack(arg: unknown): { spec: unknown; hs: string[] } {
  const hs: string[] = [];
  const walk = (x: unknown): unknown => {
    if (x instanceof EgoHandle) {
      if (x.oid === null) return x.value;
      hs.push(x.oid);
      return { __h: hs.length - 1 };
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object')
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return { spec: walk(arg), hs };
}

/** ElementHandle / JSHandle: an object in the frame's blindfill world, or a primitive value. */
class EgoHandle {
  readonly oid: string | null;
  readonly value: unknown;
  private readonly node: boolean;
  constructor(
    private frame: EgoFrame,
    r: Remote,
    /** origin of the frame this element was found in, at scan time */
    readonly origin: string,
  ) {
    this.oid = r.h ?? null;
    this.value = r.v;
    this.node = !!r.node;
  }
  private get b(): EgoBridge {
    return this.frame.b;
  }
  private async run(fn: unknown, arg: unknown, byValue: boolean): Promise<Remote> {
    if (this.oid === null) throw new BlindfillError('ACTUATOR', 'ego: not an object handle');
    const { spec, hs } = pack(arg);
    return this.b.call<Remote>('call', this.oid, this.frame.id, src(fn), spec, hs, byValue);
  }
  async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
    return (await this.run(fn, arg, true)).v;
  }
  async evaluateHandle(fn: unknown, arg?: unknown): Promise<EgoHandle> {
    return new EgoHandle(this.frame, await this.run(fn, arg, false), this.origin);
  }
  asElement(): EgoHandle | null {
    return this.node ? this : null;
  }
  getProperty(name: string): Promise<EgoHandle> {
    return this.evaluateHandle('(o, n) => o[n]', name);
  }
  async jsonValue(): Promise<unknown> {
    return this.oid === null ? this.value : this.evaluate('(o) => o');
  }
  async dispose(): Promise<void> {
    if (this.oid !== null) await this.b.call('release', this.oid);
  }
  async contentFrame(): Promise<EgoFrame | null> {
    const id = this.oid && (await this.b.call<string | null>('contentFrame', this.oid));
    return id ? this.frame.owner.frameById(id) : null;
  }
  async waitForElementState(_state: 'enabled', opts: { timeout: number }): Promise<void> {
    const deadline = Date.now() + opts.timeout;
    while (!(await this.evaluate(ENABLED))) {
      if (Date.now() > deadline) throw new BlindfillError('ACTUATOR', 'element not enabled');
      await sleep(100);
    }
  }
  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.evaluate(SCROLL);
  }
  async focus(): Promise<void> {
    await this.b.call('focus', this.oid);
    this.frame.owner.state.focused = this;
  }
  /** Like Playwright's fill: focus, select the current content, replace it. */
  async fill(value: string): Promise<void> {
    await this.focus();
    await this.evaluate(SELECT);
    if (value === '') await this.b.call('key', 'Backspace');
    else await this.type(value, false);
  }
  type(text: string, keys: boolean): Promise<void> {
    return this.b.call('typeInto', this.oid, this.origin, text, keys);
  }
  async click(): Promise<void> {
    await this.b.call('click', this.oid);
  }
  async press(key: string): Promise<void> {
    await this.focus();
    await this.b.call('key', key);
  }
}

class EgoFrame {
  parentId: string | null = null;
  constructor(
    readonly b: EgoBridge,
    readonly owner: EgoPage,
    readonly id: string,
    public currentUrl: string,
  ) {}
  url(): string {
    return this.currentUrl;
  }
  page(): EgoPage {
    return this.owner;
  }
  private origin(): string {
    try {
      return new URL(this.currentUrl).origin;
    } catch {
      return 'null'; // about:blank etc.: the typing guard refuses
    }
  }
  parentFrame(): EgoFrame | null {
    return this.parentId ? this.owner.frameById(this.parentId) : null;
  }
  isDetached(): boolean {
    return this.owner.frameById(this.id) !== this;
  }
  async $$(selector: string): Promise<EgoHandle[]> {
    const origin = this.origin();
    try {
      const ids = await this.b.call<string[]>('queryAll', this.id, selector, 200);
      return ids.map((h) => new EgoHandle(this, { h, node: true }, origin));
    } catch (e) {
      if (/SELECTOR/.test(String((e as Error).message))) throw new Error('invalid selector', { cause: e });
      throw e;
    }
  }
  /** Like Playwright: a function (or function source) gets `arg`; any other string is evaluated as an expression. */
  private async run(fn: unknown, arg: unknown, byValue: boolean): Promise<Remote> {
    if (typeof fn === 'string' && !/^\s*(async\s*)?(\(|function\b|[\w$]+\s*=>)/.test(fn))
      return this.b.call<Remote>('evalIn', this.id, fn, byValue);
    const { spec, hs } = pack(arg);
    return this.b.call<Remote>('call', null, this.id, src(fn), spec, hs, byValue);
  }
  async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
    return (await this.run(fn, arg, true)).v;
  }
  async evaluateHandle(fn: unknown, arg?: unknown): Promise<EgoHandle> {
    return new EgoHandle(this, await this.run(fn, arg, false), this.origin());
  }
}

class EgoPage {
  private frameMap = new Map<string, EgoFrame>();
  private order: EgoFrame[] = [];
  private timer: NodeJS.Timeout;
  readonly state: FocusState = {};
  readonly keyboard = {
    press: async (key: string) => {
      await this.b.call('key', key === 'ControlOrMeta+A' ? 'SelectAll' : key);
    },
    /** Types into the element last focused through this adapter (WebActuator focuses first). */
    type: async (text: string) => {
      const h = this.state.focused;
      if (!h) throw new BlindfillError('ACTUATOR', 'no focused field to type into');
      await h.type(text, true);
    },
  };

  constructor(private b: EgoBridge) {
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), 150);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    const list = await this.b.call<{ id: string; url: string; parentId: string | null }[]>('frames');
    const next = new Map<string, EgoFrame>();
    for (const f of list) {
      const fr = this.frameMap.get(f.id) ?? new EgoFrame(this.b, this, f.id, f.url);
      fr.currentUrl = f.url;
      fr.parentId = f.parentId;
      next.set(f.id, fr);
    }
    this.frameMap = next;
    this.order = list.map((f) => next.get(f.id)!);
  }
  stop(): void {
    clearInterval(this.timer);
  }
  frameById(id: string): EgoFrame | null {
    return this.frameMap.get(id) ?? null;
  }

  url(): string {
    return this.order[0]?.url() ?? 'about:blank';
  }
  mainFrame(): EgoFrame {
    return this.order[0];
  }
  /** Synchronous like Playwright; refreshed every 150 ms and after goto. */
  frames(): EgoFrame[] {
    return [...this.order];
  }
  async goto(url: string): Promise<void> {
    await this.b.call('goto', url);
    await this.refresh();
  }
  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }
  /** Request interception (rule submit kind "js") is not available through ego-browser: refuse. */
  async route(): Promise<never> {
    throw new BlindfillError('UNSUPPORTED', 'ego-cli cannot guard a submit of kind "js"; use kind "native"');
  }
  async unroute(): Promise<void> {}
  /** Playwright parity for tests; WebActuator never calls it. */
  inputValue(selector: string): Promise<unknown> {
    return this.mainFrame().evaluate('(s) => document.querySelector(s).value', selector);
  }
  title(): Promise<string> {
    return this.b.call('title');
  }
  innerText(_sel: 'body'): Promise<unknown> {
    return this.mainFrame().evaluate('document.body ? document.body.innerText : ""');
  }
  content(): Promise<unknown> {
    return this.mainFrame().evaluate('document.documentElement.outerHTML');
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.b.call<string>('screenshot'), 'base64');
  }
  /** Evidence and verify only (count, visibility of the first match), in the main frame's blindfill world. */
  locator(selector: string) {
    const top = () => this.mainFrame();
    const isVisible = () =>
      top().evaluate(`(s) => (${VISIBLE})(document.querySelector(s))`, selector) as Promise<boolean>;
    return {
      count: () => top().evaluate('(s) => document.querySelectorAll(s).length', selector) as Promise<number>,
      isVisible,
      first: () => ({ isVisible }),
    };
  }
  /** `session attach` lists pages through the context: an Ego connection holds exactly one. */
  context(): { pages(): EgoPage[] } {
    return { pages: () => [this] };
  }
}

const CAPS = {
  evaluateIsolatedWorld: true, // element scans and checks run in a blindfill isolated world
  cdp: false,
  ownsBrowser: false,
  pagesSurviveDisconnect: true,
};

export const egoCli: BrowserProvider = {
  id: 'ego-cli',
  title: 'Running Ego Lite via ego-browser (values pass through Ego’s Node runtime)',
  attachable: true,
  capabilities: CAPS,
  async connect(opts) {
    const bridge = await EgoBridge.open(parseEgoEndpoint(opts.endpoint));
    const page = new EgoPage(bridge);
    await page.refresh();
    // The adapter implements the subset of Page that WebActuator and session attach use.
    const asPage = page as unknown as Page;
    return {
      page: asPage,
      context: page.context() as unknown as BrowserContext,
      browser: null,
      capabilities: CAPS,
      close: async () => {
        page.stop();
        // a task space blindfill created keeps its page for the user; BLINDFILL_EGO_KEEP=0 closes it (tests)
        await bridge.close(process.env.BLINDFILL_EGO_KEEP !== '0');
      },
    };
  },
};
