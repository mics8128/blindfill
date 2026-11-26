# blindfill landing page

A static, one-page site: `index.html`, `style.css`, `app.js`, `favicon.svg`. No build step, no npm
dependencies, no external fonts, CDN or trackers, so it works offline.

- Languages: English (default, in the HTML) and 繁體中文 (zh-TW). The zh-TW strings live in the `zh`
  dictionary at the top of `app.js`; every translatable element carries a `data-i18n` key. The switcher
  remembers the choice; `?lang=zh-TW` forces a language.
- Theme: follows the OS (`prefers-color-scheme`), with a toggle that is remembered.
- The terminal demo respects `prefers-reduced-motion` (all lines are shown at once).

## Preview

```bash
cd site
python3 -m http.server 8080
# open http://localhost:8080
```

## Editing rules

Every factual claim must match `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md` or `docs/browsers.md`.
When the project status changes (npm release, backend verified, new browser), update the page and the zh-TW
dictionary together. Check formatting with `npx prettier --check site`.

## Deploy to GitHub Pages (later)

`.github/workflows/pages.yml` is `workflow_dispatch` only and never runs on push. To publish:

1. Repository Settings -> Pages -> Source: **GitHub Actions**.
2. Actions tab -> **Pages** -> **Run workflow**.

The site uses only relative URLs, so it also works under `https://<user>.github.io/blindfill/`.
Before the first deploy, re-read the "not published to npm yet" wording in the install section.
