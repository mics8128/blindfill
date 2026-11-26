# Handoff (paused by owner request)

Branch `site/landing` in `/home/ollie/projects/blindfill-site` (worktree of blindfill). Not pushed.

## What exists

- `site/index.html`: full one-page site (hero + terminal demo, key-facts strip, problem, how-it-works with two inline SVG diagrams, features, field-class table, comparison table, support status, "What it can't do (yet)" with threat-model note, FAQ, install CTA, footer).
- `site/style.css`: dark/light (OS + toggle), responsive, focus styles, reduced-motion handling.
- `site/app.js`: EN/zh-TW dictionary switcher, theme toggle, terminal demo animation, copy button.
- `site/favicon.svg`, `site/README.md` (preview + Pages deploy), `.github/workflows/pages.yml` (`workflow_dispatch` only), `.gitignore` entry for `site/_shots/`.
- zh-TW translation is written (all keys in the `zh` dictionary in `app.js`).
- Prettier: `site` and the workflow pass `prettier --check`.
- Headless Chromium run at 390px and 1280px (EN dark, EN light, zh-TW): no console errors, no external requests, no horizontal scroll. Screenshots in `site/_shots/` (git-ignored): mobile-en, desktop-en, desktop-en-light, mobile-zh, desktop-zh (.png).

## Not done / missing

- Screenshots were only glanced at as downscaled full-page images. Not reviewed in detail: diagram label legibility and overlap, comparison table on mobile, zh-TW layout, light theme contrast.
- No keyboard-only or contrast audit.
- The claim-to-source list has not been written. Sources to check against: README.md, SECURITY.md, docs/ARCHITECTURE.md, docs/browsers.md.
- Wording to review: the install CTA shows `npx -y blindfill` with a note that it is not published to npm yet (README says "Not published"). Comparison-table cells for extensions and cloud browsers are generic and hedged. The terminal demo output is illustrative (README says field names may differ), and the lookalike-domain and post-fill-lock messages are paraphrased, not real output.
- "Ego Lite" appears only in the support section and FAQ.
- The tested-tooling note "6 opt-in tests passed on real Camoufox" comes from docs/browsers.md.

## Preview

```
cd site && python3 -m http.server 8080
```

Use `?lang=zh-TW` for Chinese. The screenshot script is at `/tmp/shot.mjs` (uses the main checkout's playwright-core; may be gone).

## Next steps

1. Review the screenshots and fix layout problems.
2. Write the claim-to-source list.
3. Native-speaker pass on zh-TW.
4. Final report. Publishing and enabling Pages are not authorized.
