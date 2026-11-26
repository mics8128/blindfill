import type { Backend } from './backends/spi.js';
import { audit } from './core/audit.js';
import { checkWebBinding, SubmitGuard } from './core/policy.js';
import { globalScrubber } from './core/scrubber.js';
import { BlindfillError, formatTarget, type ItemMeta, type ItemRef, type Target } from './core/types.js';
import type { Detected, Expect, EvidenceResult, ProbeResult, CandidateInfo, WebActuator } from './actuators/web/web.js';
import type { Role } from './actuators/web/heuristics.js';

export interface ItemSelector {
  /** backend item id */
  item?: string;
  /** free-text search; must resolve to exactly one item */
  query?: string;
}

export interface FillRequest extends ItemSelector {
  /** field names: username, password, totp, or other item field names. Default: username,password */
  fields?: string[];
  /** navigate here first (the item binding is checked against the page the browser ends up on) */
  url?: string;
  submit?: boolean;
  expect?: Expect;
}

export interface FillResult {
  origin: string;
  item: { id: string; name: string };
  filled: string[];
  /** true when a secret was written: the session is now locked */
  locked: boolean;
  submitted: boolean;
  outcome: EvidenceResult['outcome'] | 'not_submitted';
  evidence?: { matched: EvidenceResult['matched']; url: string };
  notes: string[];
}

export type ReadableItem = {
  id: string;
  name: string;
  username?: string;
  uris: { uri: string; match: string }[];
  readable: Record<string, string>;
  /** names only: these can be filled but never read */
  secretFields: string[];
  hasTotp: boolean;
  control: { submit: string; signers: string[]; hasRules: boolean };
  notes?: string;
};

export function readableView(m: ItemMeta): ReadableItem {
  return {
    id: m.ref.id,
    name: m.name,
    username: m.username,
    uris: m.uris,
    readable: m.readable,
    secretFields: m.secretFields,
    hasTotp: m.hasTotp,
    control: { submit: m.control.submit, signers: m.control.signers, hasRules: m.control.rules !== undefined },
    notes: m.notes,
  };
}

interface RulesV1 {
  v?: number;
  fields?: Record<string, { selector?: string }>;
}

const fieldRole = (n: string): Role | null => (n === 'username' || n === 'password' || n === 'totp' ? n : null);

export class Engine {
  constructor(
    private backend: Backend,
    private web?: WebActuator,
    private persist: () => void = () => undefined,
  ) {}

  private actuator(): WebActuator {
    if (!this.web) throw new BlindfillError('ACTUATOR', 'no browser attached');
    return this.web;
  }

  async resolveItem(sel: ItemSelector, target?: Target): Promise<ItemRef> {
    if (sel.item) return { backend: this.backend.id, id: sel.item };
    const refs = sel.query ? await this.backend.find({ query: sel.query }) : target ? await this.backend.find({ target }) : [];
    if (refs.length === 0) throw new BlindfillError('NOT_FOUND', 'no matching item');
    if (refs.length > 1)
      throw new BlindfillError(
        'AMBIGUOUS',
        `${refs.length} items match; pass an explicit item id. Candidates: ${refs.map((r) => `${r.id} (${r.name ?? '?'})`).join(', ')}`,
      );
    return refs[0];
  }

  async itemShow(sel: ItemSelector): Promise<ReadableItem> {
    const ref = await this.resolveItem(sel);
    return readableView(await this.backend.meta(ref));
  }

  async totpCode(sel: ItemSelector): Promise<{ code: string; item: string; note: string }> {
    const ref = await this.resolveItem(sel);
    const code = await this.backend.totpCode(ref);
    audit({ event: 'totp', backend: this.backend.id, item: ref.id, outcome: 'returned' });
    return { code, item: ref.id, note: 'valid for ~30 seconds' };
  }

  async probe(): Promise<ProbeResult & { items?: { id: string; name?: string }[] }> {
    const act = this.actuator();
    const p = await act.probe();
    let items: { id: string; name?: string }[] | undefined;
    try {
      items = (await this.backend.find({ target: { kind: 'web', origin: p.origin } })).map((r) => ({ id: r.id, name: r.name }));
    } catch {
      items = undefined; // locked vault etc.: probe still works
    }
    audit({ event: 'probe', backend: this.backend.id, target: `web:${p.origin}`, outcome: 'ok' });
    return { ...p, items };
  }

  async candidates(role?: Role): Promise<{ origin: string; candidates: CandidateInfo[] }> {
    const p = await this.actuator().probe();
    const c = role ? p.candidates.filter((x) => x.guess?.role === role) : p.candidates;
    return { origin: p.origin, candidates: c };
  }

  async fill(req: FillRequest): Promise<FillResult> {
    const act = this.actuator();
    const notes: string[] = [];
    if (req.url) await act.navigate(req.url);
    const { target, url } = act.identify();
    const tname = formatTarget(target);
    const ref = await this.resolveItem(req, target);
    const meta = await this.backend.meta(ref);

    const refuse = (reason: string, err: BlindfillError): never => {
      audit({ event: 'refused', backend: this.backend.id, item: ref.id, target: tname, reason });
      throw err;
    };

    // 1. origin binding, before any secret is read
    const bind = checkWebBinding(url, meta);
    if (!bind.ok) refuse(bind.reason, new BlindfillError('ORIGIN_MISMATCH', `refused: ${tname} is not bound by this item (${bind.reason})`));
    const isBound = (u: string) => checkWebBinding(u, meta).ok;

    // 2. classify the request; everything unknown is rejected before anything happens
    const names = req.fields?.length ? req.fields : ['username', 'password'];
    type Step = { name: string; kind: 'readable' | 'secret' | 'totp' };
    const steps: Step[] = [];
    for (const name of names) {
      if (name === 'totp') {
        if (!meta.hasTotp || !this.backend.capabilities.has('TOTP'))
          refuse('no totp', new BlindfillError('NOT_FOUND', 'this item has no TOTP'));
        steps.push({ name, kind: 'totp' });
      } else if (meta.secretFields.includes(name)) steps.push({ name, kind: 'secret' });
      else if (name === 'username' ? !!meta.username : name in meta.readable) steps.push({ name, kind: 'readable' });
      else refuse('unknown field', new BlindfillError('NOT_FOUND', `item has no fillable field "${name}"`));
    }
    steps.sort((a, b) => ({ readable: 0, totp: 1, secret: 2 })[a.kind] - ({ readable: 0, totp: 1, secret: 2 })[b.kind]);
    for (const s of steps.filter((x) => x.kind === 'secret')) {
      try {
        act.policy.assertFirstSecretFill(target.origin, s.name);
      } catch (e) {
        refuse('one-shot', e as BlindfillError);
      }
    }

    // 3. locate EVERY field before reading ANY secret (fail closed)
    const rules = (meta.control.rules ?? {}) as RulesV1;
    const locator = (s: Step) => async (ds?: Detected[]): Promise<Detected> => {
      const sel = rules.fields?.[s.name]?.selector;
      if (typeof sel === 'string') return act.locateBySelector(sel, isBound);
      const role = fieldRole(s.name);
      return act.locate(role ? { role } : { name: s.name }, isBound, ds);
    };
    try {
      const ds = await act.detectStable();
      for (const s of steps) await locator(s)(ds);
    } catch (e) {
      const be = e as BlindfillError;
      audit({ event: 'refused', backend: this.backend.id, item: ref.id, target: tname, reason: `${be.code}: ${be.message}` });
      throw e;
    }

    // 4. fill
    const filled: string[] = [];
    let last: Detected | undefined;
    let wroteSecret = false;
    const guard = new SubmitGuard();
    try {
      for (const s of steps) {
        const relocate = () => locator(s)();
        if (s.kind === 'secret') {
          act.policy.lock(); // lock BEFORE the value leaves the backend, even if the fill then fails
          wroteSecret = true;
          this.persist();
          const handle = await this.backend.openSecret(ref, s.name);
          await handle.into(async (buf) => {
            const r = await act.fillInto(relocate, buf, isBound);
            last = r.last;
          });
          act.policy.recordSecretFill(target.origin, s.name);
        } else {
          const value =
            s.kind === 'totp'
              ? await this.backend.totpCode(ref)
              : s.name === 'username'
                ? (meta.username as string)
                : meta.readable[s.name];
          const r = await act.fillInto(relocate, value, isBound);
          if (s.kind !== 'totp' || !last) last = r.last;
        }
        filled.push(s.name);
      }
    } catch (e) {
      const be = e as BlindfillError;
      audit({
        event: 'fill',
        backend: this.backend.id,
        item: ref.id,
        target: tname,
        fields: filled,
        outcome: 'error',
        reason: globalScrubber.scrub(`${be.code ?? 'ERR'}: ${be.message}`),
      });
      throw e;
    } finally {
      this.persist();
    }

    audit({ event: 'fill', backend: this.backend.id, item: ref.id, target: tname, fields: filled, outcome: 'ok' });

    // 5. optional single submit
    let submitted = false;
    let outcome: FillResult['outcome'] = 'not_submitted';
    let evidence: FillResult['evidence'];
    if (req.submit) {
      if (meta.control.submit === 'none') notes.push('item policy blindfill.submit=none: not submitted');
      else if (!last) notes.push('nothing was filled: not submitted');
      else {
        guard.take();
        const how = await act.submit(last);
        submitted = true;
        audit({ event: 'submit', backend: this.backend.id, item: ref.id, target: tname, outcome: how });
        const ev = await act.evidence(req.expect);
        outcome = ev.outcome;
        evidence = { matched: ev.matched, url: ev.url };
        if (ev.outcome === 'unknown') notes.push('outcome unknown; blindfill does not retry. Check with your own evidence selectors.');
      }
    }
    if (wroteSecret) notes.push('session is locked: page text, DOM and screenshots are refused until session stop');
    return {
      origin: target.origin,
      item: { id: ref.id, name: meta.name },
      filled,
      locked: act.policy.locked,
      submitted,
      outcome,
      evidence,
      notes,
    };
  }

  async fillTotp(req: Omit<FillRequest, 'fields'>): Promise<FillResult> {
    return this.fill({ ...req, fields: ['totp'] });
  }

  async stop(): Promise<void> {
    await this.web?.close();
  }
}
