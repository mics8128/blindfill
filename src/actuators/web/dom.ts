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

const SUBMIT_SRC = `(el) => {
  const sel = 'button[type=submit], input[type=submit], button:not([type]), [role=button][type=submit]';
  let scope = el.form || null;
  if (!scope) {
    scope = el.parentElement;
    for (let i = 0; i < 4 && scope && !scope.querySelector(sel); i++) scope = scope.parentElement;
  }
  if (!scope) return null;
  const all = Array.from(scope.querySelectorAll(sel));
  const ok = all.filter((b) => {
    if (b.disabled) return false;
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(b);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  });
  return ok[0] || null;
}`;

export const DESCRIBE_FIELD = mk<(el: any) => any>(DESCRIBE_SRC);
export const VALUE_EQUALS = mk<(el: any, expected: string) => boolean>(VALUE_SRC);
export const IS_FOCUSED = mk<(el: any) => boolean>(FOCUSED_SRC);
export const FIND_SUBMIT = mk<(el: any) => any>(SUBMIT_SRC);
