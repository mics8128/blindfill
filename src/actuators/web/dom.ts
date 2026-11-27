/**
 * Scripts evaluated inside the page. They are kept as source strings and turned into real function
 * objects with `new Function` in Node, so that bundler helpers such as __name are never injected into
 * the page context (Playwright serialises fn.toString()). None of them reads or returns an input's value.
 */
const mk = <T>(src: string): T => new Function('return ' + src)() as T;
const DESCRIBE_SRC = `(el) => {
  const reasons = [];
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase();
  if (type === 'hidden') reasons.push('type-hidden');
  const vis = typeof el.checkVisibility === 'function'
    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : cs.display !== 'none' && cs.visibility !== 'hidden';
  if (!vis) reasons.push('not-visible');
  if (parseFloat(cs.opacity) < 0.1) reasons.push('transparent');
  if (r.width < 4 || r.height < 4) reasons.push('tiny');
  const de = document.documentElement;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= Math.max(de.scrollWidth, innerWidth) || r.top >= Math.max(de.scrollHeight, innerHeight)) reasons.push('off-screen');
  if (/inset\\(\\s*(50|100)%/.test(cs.clipPath || '') || /rect\\(\\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\\s*\\)/.test(cs.clip || '')) reasons.push('clipped');
  for (let p = el; p; p = p.parentElement || (p.getRootNode && p.getRootNode().host)) {
    if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') { reasons.push('aria-hidden'); break; }
    if (p.inert) { reasons.push('inert'); break; }
  }
  const texts = [];
  if (el.labels) for (const l of el.labels) texts.push(l.innerText || l.textContent || '');
  const lb = el.getAttribute('aria-labelledby');
  if (lb) for (const id of lb.split(/\\s+/)) { const n = document.getElementById(id); if (n) texts.push(n.textContent || ''); }
  const wrap = el.closest && el.closest('label');
  if (wrap && !texts.length) texts.push(wrap.textContent || '');
  const clip = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  return {
    tag: el.tagName.toLowerCase(),
    type,
    name: clip(el.getAttribute('name')),
    id: clip(el.id),
    autocomplete: clip(el.getAttribute('autocomplete')),
    ariaLabel: clip(el.getAttribute('aria-label')),
    placeholder: clip(el.getAttribute('placeholder')),
    label: clip(texts.join(' ')),
    inputmode: clip(el.getAttribute('inputmode')),
    maxlength: el.maxLength > 0 ? el.maxLength : 0,
    reasons,
    disabled: !!el.disabled,
    readOnly: !!el.readOnly,
  };
}`;

/** Exact-value check inside the page; returns only a boolean. */
const VALUE_SRC = `(el, expected) => el.value === expected`;

const FOCUSED_SRC = `(el) => {
  const root = el.getRootNode();
  return (root.activeElement || document.activeElement) === el;
}`;

export const DESCRIBE_FIELD = mk<(el: any) => any>(DESCRIBE_SRC);
export const VALUE_EQUALS = mk<(el: any, expected: string) => boolean>(VALUE_SRC);
export const IS_FOCUSED = mk<(el: any) => boolean>(FOCUSED_SRC);

// ---- rule scopes, submit safety, diagnose (all value-free; booleans/counts/structure only) --------------

const COUNT_SRC = String.raw`(root, sel) => {
  try { return root.querySelectorAll(sel).length; } catch (e) { return -1; }
}`;
const FIRST_SRC = String.raw`(root, sel) => {
  const all = root.querySelectorAll(sel);
  return all.length === 1 ? all[0] : null;
}`;
/** fields owned by the group: native form => el.form === group; container => no form owner */
const COUNT_IN_GROUP_SRC = String.raw`(group, a) => {
  try {
    return Array.from(group.querySelectorAll(a.sel)).filter((e) => (a.native ? e.form === group : e.form === null)).length;
  } catch (e) { return -1; }
}`;
const FIRST_IN_GROUP_SRC = String.raw`(group, a) => {
  const m = Array.from(group.querySelectorAll(a.sel)).filter((e) => (a.native ? e.form === group : e.form === null));
  return m.length === 1 ? m[0] : null;
}`;
const GROUP_KIND_SRC = String.raw`(g, native) => (native ? g instanceof HTMLFormElement : !(g instanceof HTMLFormElement))`;
const IS_FRAME_SRC = String.raw`(e) => e.tagName === 'IFRAME' || e.tagName === 'FRAME'`;

/** Submit control checks (port of olliepm _check_submit). a.outside: a js control outside every form (an <a> is allowed). */
const SUBMIT_CHECK_SRC = String.raw`(e, a) => {
  const g = a.group;
  const roleBtn = e instanceof HTMLElement && ['DIV', 'SPAN'].includes(e.tagName) && (e.getAttribute('role') || '').toLowerCase() === 'button';
  const anchor = a.outside && e instanceof HTMLAnchorElement;
  const owner = roleBtn || anchor ? e.closest('form') : e.form;
  const cs = getComputedStyle(e);
  const visible = e.isConnected && e.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  const isBtn = (e instanceof HTMLButtonElement && ['button', 'submit'].includes(e.type)) || (e instanceof HTMLInputElement && ['button', 'submit'].includes(e.type)) || roleBtn || anchor;
  const isSubmit = (e instanceof HTMLButtonElement && e.type === 'submit') || (e instanceof HTMLInputElement && e.type === 'submit');
  if (!visible || !isBtn) return { code: 'unsafe' };
  if (e.closest('[inert]')) return { code: 'disabled' };
  // a.pending: checked before filling; many sites enable submit only once the fields hold values
  if (!a.pending && (e.hasAttribute('disabled') || e.matches(':disabled') || e.closest('[aria-disabled="true"]'))) return { code: 'disabled' };
  if (roleBtn && ['form', 'formaction', 'formmethod', 'formtarget', 'formenctype', 'formnovalidate'].some((x) => e.hasAttribute(x))) return { code: 'unsafe' };
  if (!a.native) {
    if (owner !== null || ['formaction', 'formmethod', 'formtarget', 'form'].some((x) => e.hasAttribute(x))) return { code: 'unsafe' };
    return { code: 'ok' };
  }
  if (a.outside ? owner !== null || e.closest('form') || ['formaction', 'formmethod', 'formtarget', 'form'].some((x) => e.hasAttribute(x)) : owner !== g) return { code: 'unsafe' };
  const action = e.hasAttribute('formaction') ? e.formAction : g.action;
  const method = (e.hasAttribute('formmethod') ? e.formMethod : g.method).toLowerCase();
  let target = e.hasAttribute('formtarget') ? e.getAttribute('formtarget') : g.getAttribute('target');
  if (!target) { const b = e.ownerDocument.querySelector('base[target]'); target = (b && b.getAttribute('target')) || ''; }
  const self = ['', '_self'].includes(target.toLowerCase());
  if (a.kind === 'js' && self && ['get', 'post'].includes(method)) return { code: 'ok', action };
  if (method === 'get' && self) return { code: 'unsafe', reason: 'native_get' };
  if (method !== 'post' || !self) return { code: 'unsafe' };
  if (a.kind === 'native' && !isSubmit) return { code: 'unsafe' };
  return { code: 'ok', action };
}`;

/** Rule-less fill: the form owner of a field (null when formless). */
const FORM_OF_SRC = String.raw`(el) => el.form || null`;

/** Visible native submit controls owned by a form (rule-less submit needs exactly one). */
const FORM_SUBMITS_SRC = String.raw`(form) => Array.from(form.elements).filter((b) => {
  if (!((b instanceof HTMLButtonElement && b.type === 'submit') || (b instanceof HTMLInputElement && b.type === 'submit'))) return false;
  const cs = getComputedStyle(b);
  return b.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
})`;

/**
 * Rule-less form choice: boolean/code only. a.pwds are the visible password fields of this frame;
 * a.otherFrames counts visible password fields elsewhere; a.user is the chosen username field or null.
 */
const GENERIC_SCOPE_SRC = String.raw`(pwd, a) => {
  if ((pwd.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('new-password')) return 'new_password';
  if (a.pwds.some((p) => p !== pwd && p.form === pwd.form) || a.pwds.some((p) => p.form !== pwd.form) || a.otherFrames > 0) return 'multi_password';
  if (a.user && a.user.form !== pwd.form) return 'split';
  return 'ok';
}`;

const SUBMIT_GUARD_SRC = String.raw`(doc, form) => {
  if (doc !== document || form.ownerDocument !== doc || !form.isConnected) throw new Error('document_changed');
  const prevent = (event) => { if (event.target === form) event.preventDefault(); };
  doc.addEventListener('submit', prevent, true);
  return () => doc.removeEventListener('submit', prevent, true);
}`;

/** field-to-field equality for registration (no value ever leaves the page; only a boolean) */
const SAME_VALUE_SRC = String.raw`(a, b) => a.type === 'password' && b.type === 'password' && a.value.length > 0 && a.value === b.value`;

/** structural diagnosis; paths are tag/nth-of-type only (arbitrary id/name/placeholder strings are never exported) */
const DIAGNOSE_SRC = String.raw`(doc, args) => {
  const visible = (e) => {
    if (!e.isConnected || !Array.from(e.getClientRects()).some((r) => r.width > 0 && r.height > 0)) return false;
    for (let p = e; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (p.hasAttribute('hidden') || p.hasAttribute('inert') || s.display === 'none' || ['hidden', 'collapse'].includes(s.visibility) || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const enabled = (e) => !e.hasAttribute('disabled') && !e.matches(':disabled') && !e.closest('[aria-disabled="true"], [inert]');
  const editable = (e) => visible(e) && enabled(e) && !e.readOnly && (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement);
  const OK = ['html','body','main','section','article','div','span','form','fieldset','label','input','textarea','button','p','table','tbody','tr','td','th','ul','ol','li','header','footer','nav','aside','dialog'];
  const path = (e) => {
    const parts = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      if (!OK.includes(tag)) return null;
      const sib = n.parentElement ? Array.from(n.parentElement.children).filter((s) => s.tagName === n.tagName) : [n];
      parts.unshift(tag + ':nth-of-type(' + (sib.indexOf(n) + 1) + ')');
      if (parts.length > 24) return null;
    }
    return parts.join(' > ');
  };
  const typed = (e, kind) => {
    if (kind === 'password') return e instanceof HTMLInputElement && e.type === 'password';
    if (kind === 'totp') return e instanceof HTMLInputElement && ['text', 'tel', 'number', 'password'].includes(e.type);
    return e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && ['text', 'email', 'tel', 'url', 'search'].includes(e.type));
  };
  const all = Array.from(doc.querySelectorAll('input,textarea,button,form'));
  let mapping = null;
  if (args.rule) {
    const native = args.rule.form != null;
    let groups = [];
    try { groups = Array.from(doc.querySelectorAll(native ? args.rule.form : args.rule.container)); } catch (e) { groups = []; }
    const defs = Object.assign({}, args.rule.fields);
    if (args.rule.confirm_password) defs.confirm_password = args.rule.confirm_password;
    mapping = { groups: groups.length, fields: Object.entries(defs).map(([field, sel]) => {
      let found = [];
      try { found = groups.length === 1 ? Array.from(groups[0].querySelectorAll(sel)).filter((e) => (native ? e.form === groups[0] : e.form === null)) : []; } catch (e) { found = []; }
      return { field, matches: found.length, visible: found.length === 1 && visible(found[0]), editable: found.length === 1 && !!editable(found[0]), type_compatible: found.length === 1 && typed(found[0], args.kinds[field] || 'text') };
    }) };
  }
  return { total: all.length, mapping, controls: all.slice(0, 80).map((e) => {
    const selector = path(e);
    const type = e instanceof HTMLInputElement || e instanceof HTMLButtonElement ? e.type : null;
    let matches = 0;
    try { matches = selector ? doc.querySelectorAll(selector).length : 0; } catch (x) { matches = 0; }
    return { tag: e.tagName.toLowerCase(), type, selector, matches, visible: visible(e), enabled: !!enabled(e), editable: !!editable(e),
      has_name: e.hasAttribute('name'), has_id: e.hasAttribute('id'), form_selector: e.form ? path(e.form) : null,
      sensitive: e instanceof HTMLInputElement && (e.type === 'password' || (e.getAttribute('autocomplete') || '').toLowerCase().includes('one-time-code')) };
  }) };
}`;

export const COUNT_SEL = mk<(root: any, sel: string) => number>(COUNT_SRC);
export const FIRST_SEL = mk<(root: any, sel: string) => any>(FIRST_SRC);
export const COUNT_IN_GROUP = mk<(g: any, a: { sel: string; native: boolean }) => number>(COUNT_IN_GROUP_SRC);
export const FIRST_IN_GROUP = mk<(g: any, a: { sel: string; native: boolean }) => any>(FIRST_IN_GROUP_SRC);
export const GROUP_KIND = mk<(g: any, native: boolean) => boolean>(GROUP_KIND_SRC);
export const IS_FRAME_EL = mk<(e: any) => boolean>(IS_FRAME_SRC);
export const SUBMIT_CHECK =
  mk<(e: any, a: { group: any; native: boolean; kind: string; pending: boolean; outside: boolean }) => any>(
    SUBMIT_CHECK_SRC,
  );
export const FORM_OF = mk<(el: any) => any>(FORM_OF_SRC);
/** resolved action URL; the prototype getter, since a control named "action" would shadow g.action */
export const FORM_ACTION = mk<(g: any) => string>(
  String.raw`(g) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get.call(g)`,
);
export const FORM_SUBMITS = mk<(form: any) => any[]>(FORM_SUBMITS_SRC);
export const GENERIC_SCOPE =
  mk<(pwd: any, a: { pwds: any[]; otherFrames: number; user: any }) => string>(GENERIC_SCOPE_SRC);
export const SUBMIT_GUARD = mk<(doc: any, form: any) => any>(SUBMIT_GUARD_SRC);
export const SAME_VALUE = mk<(a: any, b: any) => boolean>(SAME_VALUE_SRC);
export const DIAGNOSE = mk<(doc: any, args: any) => any>(DIAGNOSE_SRC);

const PWD_COUNT_SRC = String.raw`(g, a) => Array.from(g.querySelectorAll('input[type=password]')).filter((e) => (a.native ? e.form === g : e.form === null)).length`;
export const PWD_COUNT = mk<(g: any, a: { native: boolean }) => number>(PWD_COUNT_SRC);
