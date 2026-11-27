# blindfill landing page

Live at <https://mics8128.github.io/blindfill/>.

A static, one-page site: `index.html`, `style.css`, `app.js`, `favicon.svg`. No build step, no npm
dependencies, no external fonts, CDN or trackers, so it works offline.

- Languages: English (default, in the HTML) and 繁體中文 (zh-TW). The zh-TW strings live in the `zh`
  dictionary at the top of `app.js`; every translatable element carries a `data-i18n` key. The switcher
  remembers the choice; `?lang=zh-TW` forces a language.
- Theme: follows the OS (`prefers-color-scheme`), with a toggle that is remembered.
- The terminal demo respects `prefers-reduced-motion` (all lines are shown at once).
- Keep the page short: what it is, why it's safe, what it works with, how to start. Details (support matrix,
  limits, comparison) live in `docs/TESTED.md`, `SECURITY.md` and `docs/COMPARISON.md` on main; link there.

## Preview

```bash
cd site
python3 -m http.server 8080
# open http://localhost:8080
```

## Editing rules

Every factual claim must match `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md` or `docs/browsers.md`
on main. When the project status changes (npm release, backend verified, new browser), update the page and
the zh-TW dictionary together. Check formatting with `npx prettier --check site`.

## Deploy

GitHub Pages serves the root of the `gh-pages` branch, which is `site/` split out of `site/landing`:

```bash
git subtree split --prefix site site/landing -b gh-pages-next
git push origin gh-pages-next:gh-pages   # fast-forward only, never force
git branch -D gh-pages-next
```

`.nojekyll` keeps Pages from running Jekyll. All asset paths are relative, so the site works under
`/blindfill/`.
