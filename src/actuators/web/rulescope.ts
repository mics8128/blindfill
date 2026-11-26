/**
 * Rule-driven location of fields and the submit control. Everything here is evaluated with the page's own
 * querySelectorAll (never Playwright selector engines) and returns handles/booleans, never values.
 */
import type { ElementHandle, Frame, Page } from 'playwright-core';
import { BlindfillError } from '../../core/types.js';
import type { Rule } from '../../rules.js';
import {
  COUNT_IN_GROUP,
  COUNT_SEL,
  DESCRIBE_FIELD,
  FIRST_IN_GROUP,
  FIRST_SEL,
  GROUP_KIND,
  IS_FRAME_EL,
  SUBMIT_CHECK,
  SUBMIT_GUARD,
} from './dom.js';
import type { FieldDescriptor } from './heuristics.js';
import type { Detected } from './web.js';

export interface RuleScope {
  rule: Rule;
  frame: Frame;
  group: ElementHandle;
  native: boolean;
}

const httpUrl = (u: string): boolean => /^https?:\/\//i.test(u);
const originOf = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

async function unique(root: ElementHandle, sel: string, what: string): Promise<ElementHandle> {
  const count = await root.evaluate(COUNT_SEL, sel).catch(() => -1);
  if (count < 0) throw new BlindfillError('POLICY', `${what}: invalid CSS selector`);
  if (count === 0) throw new BlindfillError('NOT_FOUND', `${what}: selector matched nothing`);
  if (count > 1)
    throw new BlindfillError('AMBIGUOUS', `${what}: selector matched ${count} elements (need exactly 1)`);
  const el = (await root.evaluateHandle(FIRST_SEL, sel)).asElement();
  if (!el) throw new BlindfillError('NOT_FOUND', `${what}: element vanished`);
  return el;
}

/** Open the rule's frame + form/container. The page origin and frame origin must be bound by the item. */
export async function openRuleScope(
  page: Page,
  rule: Rule,
  isBound: (url: string) => boolean,
): Promise<RuleScope> {
  if (!httpUrl(page.url()) || originOf(page.url()) !== rule.top_origin)
    throw new BlindfillError('ORIGIN_MISMATCH', 'the page is not on the origin this rule is for');
  let frame = page.mainFrame();
  if (rule.frame) {
    const top = await documentRoot(frame);
    const iframe = await unique(top, rule.frame.selector, 'rule frame');
    if (!(await iframe.evaluate(IS_FRAME_EL)))
      throw new BlindfillError('POLICY', 'rule frame selector is not an iframe');
    const inner = await iframe.contentFrame();
    if (!inner || inner.parentFrame() !== page.mainFrame())
      throw new BlindfillError('NOT_FOUND', 'rule frame is not a direct child frame');
    const fo = originOf(inner.url());
    if (fo !== rule.frame.origin)
      throw new BlindfillError('ORIGIN_MISMATCH', 'frame origin differs from the rule');
    if (!isBound(inner.url()))
      throw new BlindfillError('ORIGIN_MISMATCH', 'the frame origin is not bound by the vault item: refused');
    frame = inner;
  }
  const native = rule.form !== undefined;
  const root = await documentRoot(frame);
  const group = await unique(root, (native ? rule.form : rule.container) as string, 'rule form/container');
  if (!(await group.evaluate(GROUP_KIND, native)))
    throw new BlindfillError('POLICY', 'rule form/container is the wrong kind of element');
  return { rule, frame, group, native };
}

async function documentRoot(frame: Frame): Promise<ElementHandle> {
  const el = (await frame.evaluateHandle('document.documentElement')).asElement();
  if (!el) throw new BlindfillError('ACTUATOR', 'no document');
  return el;
}

const TEXTY = ['text', 'email', 'tel', 'url', 'search', 'textarea', ''];
const TOTPY = ['text', 'tel', 'number', 'password', ''];

/** Locate one named field inside the rule scope. Fresh scope per call so SPA re-renders are survived. */
export async function locateInScope(scope: RuleScope, name: string, selector?: string): Promise<Detected> {
  const sel =
    selector ?? (name === 'confirm_password' ? scope.rule.confirm_password : scope.rule.fields[name]);
  if (!sel) throw new BlindfillError('NOT_FOUND', `the rule has no selector for field "${name}"`);
  const a = { sel, native: scope.native };
  const count = await scope.group.evaluate(COUNT_IN_GROUP, a).catch(() => -1);
  if (count < 0) throw new BlindfillError('POLICY', `rule selector for "${name}" is not valid CSS`);
  if (count === 0) throw new BlindfillError('NOT_FOUND', `rule selector for "${name}" matched no field`);
  if (count > 1)
    throw new BlindfillError(
      'AMBIGUOUS',
      `rule selector for "${name}" matched ${count} fields (need exactly 1)`,
    );
  const handle = (await scope.group.evaluateHandle(FIRST_IN_GROUP, a)).asElement();
  if (!handle) throw new BlindfillError('NOT_FOUND', `field "${name}" vanished`);
  const desc = (await handle.evaluate(DESCRIBE_FIELD)) as FieldDescriptor;
  if (desc.reasons.length || desc.disabled || desc.readOnly)
    throw new BlindfillError(
      'AMBIGUOUS',
      `field "${name}" is not usable (${desc.reasons.join(',') || 'disabled/readonly'})`,
    );
  const okType =
    name === 'password' || name === 'confirm_password'
      ? desc.type === 'password'
      : name === 'totp'
        ? TOTPY.includes(desc.type)
        : name === 'username'
          ? TEXTY.includes(desc.type)
          : desc.type !== 'hidden';
  if (!okType) throw new BlindfillError('AMBIGUOUS', `field "${name}" has an incompatible input type`);
  const frameUrl = scope.frame.url();
  return {
    desc,
    handle,
    frame: scope.frame,
    inTop: scope.frame === scope.frame.page().mainFrame(),
    frameUrl,
  };
}

/** Validate the submit control per rule; returns it. Throws POLICY("unsafe form") on anything unclear. */
export async function resolveRuleSubmit(
  scope: RuleScope,
  isBound: (url: string) => boolean,
): Promise<ElementHandle> {
  const s = scope.rule.submit;
  if (!s)
    throw new BlindfillError(
      'POLICY',
      'unsafe form: the rule has no submit control (add "submit" to the rule)',
    );
  const submitter = await unique(scope.group, s.selector, 'rule submit').catch((e: BlindfillError) => {
    throw new BlindfillError('POLICY', `unsafe form: submit control: ${e.message}`);
  });
  const r = (await submitter.evaluate(SUBMIT_CHECK, {
    group: scope.group,
    native: scope.native,
    kind: s.kind,
  })) as {
    code: string;
    reason?: string;
    action?: string;
  };
  if (r.code !== 'ok')
    throw new BlindfillError(
      'POLICY',
      r.reason === 'native_get'
        ? 'unsafe form: a native GET form would put the filled values into the URL; submit refused (use kind "js" only if the site handles it in JS, or submit by hand)'
        : `unsafe form: submit control is ${r.code}`,
    );
  if (r.action !== undefined) {
    if (originOf(r.action) !== originOf(scope.frame.url()) || !isBound(r.action))
      throw new BlindfillError(
        'POLICY',
        'unsafe form: the form action leaves the bound origin; submit refused',
      );
  }
  return submitter;
}

/** Click the validated submit control once. For kind "js": block GET navigations and default submission. */
export async function clickRuleSubmit(
  page: Page,
  scope: RuleScope,
  submitter: ElementHandle,
  recheck: () => Promise<void>,
): Promise<void> {
  if (scope.rule.submit?.kind !== 'js') {
    await submitter.click({ timeout: 5000, noWaitAfter: true });
    return;
  }
  const frame = scope.frame;
  const block = async (route: import('playwright-core').Route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.method() === 'GET' && req.frame() === frame)
      await route.abort('blockedbyclient');
    else await route.fallback();
  };
  await page.route('**/*', block);
  let guard: import('playwright-core').JSHandle | undefined;
  try {
    const doc = await frame.evaluateHandle('document');
    guard = await doc.evaluateHandle(SUBMIT_GUARD, scope.group);
    await recheck();
    await submitter.click({ timeout: 5000, noWaitAfter: true });
  } finally {
    if (guard) await guard.evaluate((c: () => void) => c()).catch(() => undefined);
    await page.unroute('**/*', block).catch(() => undefined);
  }
}
