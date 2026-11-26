# Handoff

Branch `site/landing` in the `blindfill-site` worktree. Not pushed, not deployed.

## Done

- Layout checked in a real browser at 1440px and 390px, EN and zh-TW: no horizontal page scroll, no console errors, no external requests. Wide tables, the terminal and the code block scroll inside keyboard-focusable regions.
- Keyboard: skip link, every control reachable in a sane order, 3px focus outline everywhere, language buttons work with Enter/Space, no traps.
- Contrast (computed, WCAG AA): all text pairs >= 5.2:1 in light and >= 7.0:1 in dark (lowest: light comparison "us" column 5.22, light pill.warn 5.27).
- `prefers-reduced-motion`: terminal shows all lines at once, diagram animation off, no smooth scroll. The diagram animation otherwise stops after 5 loops.
- zh-TW now also covers the diagrams, their accessible title/description and the `aria-label`s.
- Claims audited against README.md, SECURITY.md, docs/ARCHITECTURE.md and docs/browsers.md of main @ fa64962 and corrected:
  - Firefox/Camoufox: loopback Playwright server, opt-in suite, Camoufox 158.0.1-beta.41 and 159.0-beta.43 (no test count, it differs between docs).
  - Passkeys: shown as "limited" (web sign-in, Chromium only, fake relying party, no counter write-back, no registration), no longer "planned/not supported".
  - Install: the `npx -y blindfill` one-liner is gone (the npm `latest` is an empty placeholder); only build-from-source steps, with a copy button.
  - "Fails closed": honeypots are skipped, not a stop condition.
  - Comparison table: removed "Not protected" claims about extensions and cloud browsers (now "Varies").
  - Source links added for features, field classes and support status.

## Needs the owner

- Deploy decision: Pages is not enabled, the workflow is `workflow_dispatch` only. Nothing was published.
- Native-speaker pass on zh-TW.
- Re-check the support section when main changes (it names commit fa64962); update once the npm release exists.
- The terminal demo output is still illustrative (caption says so).

## Preview

```
cd site && python3 -m http.server 8080
```

Use `?lang=zh-TW` for Chinese.
