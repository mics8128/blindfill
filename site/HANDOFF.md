# Handoff

Branch `site/landing` in the `blindfill-site` worktree. Published to <https://mics8128.github.io/blindfill/>
from the `gh-pages` branch (see `README.md`, "Deploy").

## Done

- Repositioned around sign-in plus password manager integration: one-line hero, result-first section titles,
  removed the badge, fact strip and problem section, FAQ cut to four questions.
- Comparison, field-class and support tables share one style and stack into one block per row below 640px.
- GitHub link with icon in the nav (always visible) and footer. No star count: it would need a request to
  the GitHub API.
- Checked in Chromium at 1440px and 390px, light and dark, EN and zh-TW: no horizontal scroll, no console
  errors, no external requests. Computed contrast of every token pair >= 5.47:1.
- Claims match README.md and SECURITY.md of main at cd3eb8e (bw mock-tested only, six backends unverified,
  Android tested on one phone with a fake app, passkeys limited, not on npm).

## Needs the owner

- Native-speaker pass on zh-TW.
- Update the support table when main changes (npm release, live-vault test, new browser).
- The terminal demo output is illustrative (caption says so).

## Preview

```
cd site && python3 -m http.server 8080
```

Use `?lang=zh-TW` for Chinese.
