<div align="center">

# blindfill

**讓 AI 代理登入網站，卻永遠看不到密碼。**

**[網站：mics8128.github.io/blindfill](https://mics8128.github.io/blindfill/)**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

讓 AI 代理登入網站，**卻永遠看不到密碼**。blindfill 會從你的密碼管理器讀取憑證，確認它綁定於該頁面的來源（origin），再將其輸入真實的表單，並且只回傳頁面結構與執行結果。機密值是唯寫的（`SecretHandle.into(sink)`），輸出時會被清除（scrub），且填寫完成後工作階段（session）即鎖定。

> **狀態：alpha（0.1.0-alpha.0）。** 請先閱讀 [SECURITY.md](SECURITY.md)，了解威脅模型與已知缺口。

## 範例：密碼不經過 LLM

以下輸出僅為示意，欄位名稱可能略有不同。

1. **登入。** agent 帶項目 ID 和登入網址呼叫 `fill`。blindfill 從 `bw` 取出密碼，直接輸入表單，只回傳 `{"ok": true, "url": ".../home"}`。模型只看到結果，看不到密碼。
2. **釣魚與提示注入。** 仿冒網域（`examp1e.com`）或跨網域 iframe 會在**讀取任何機密之前**就被拒絕，惡意網頁無法誘使 agent 把密碼輸入到別處。
3. **一次性驗證碼。** `totp_code` 回傳目前的 6 位數驗證碼（可讀、可填入，與文字相同）。TOTP 種子永遠不離開後端。
4. **填寫後鎖定。** 填寫後，工作階段會拒絕提供頁面文字、DOM 和截圖，頁面即使回顯密碼也無法洩漏給模型。

## 支援的後端與瀏覽器

| 後端                                                                                                | 等級                          | 說明                                                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Bitwarden / Vaultwarden（`bw`）                                                                     | 已驗證（模擬 CLI + 測試資料） | 項目 JSON 格式另以人工對照過真實 Vaultwarden。blindfill 對真實 Vault 的端到端測試：尚未。   |
| 1Password（`op`）、rbw、pass、gopass、KeePassXC（`keepassxc-cli`）、Secret Service（`secret-tool`） | 盲寫、未驗證                  | 僅在測試資料上通過共用契約測試。歡迎執行 `blindfill backend selftest <id>` 並提交後端回報。 |

| 瀏覽器                                                                            | 狀態                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium：Playwright 內建、任何 Chromium 組建（`--executable`），或本機回環 CDP   | 支援，已測試                                                                                                                                                                                                                                                                                  |
| Firefox / Camoufox，透過本機回環 Playwright 伺服器（`--browser firefox-connect`） | 已測試（選用測試套件），版本為 Camoufox 158.0.1-beta.41 與 159.0-beta.43；長時間執行的實例未測試                                                                                                                                                                                              |
| Ego Lite                                                                          | 僅限獨立、空白設定檔的實例（`--executable`）；不支援連接執行中的應用程式                                                                                                                                                                                                                      |
| WebKit / Safari                                                                   | 不支援                                                                                                                                                                                                                                                                                        |
| Android（14 以上）                                                                | 輔助 APK：密碼走自動填入服務，passkey 走憑證提供者（在主機端簽署）；正式簽章，每次填入前主機都會核對手機上 APK 的簽章；以 `blindfill android install --serial <s>` 安裝（[android/README.md](android/README.md)）；已用假 app 在一支手機（Xperia 5 II，Android 17）與模擬器（Android 16）測試 |
| Passkey                                                                           | 網頁登入，僅 Chromium（以假 relying party 測試）；不回寫計數器、不支援註冊                                                                                                                                                                                                                    |

瀏覽器提供者及其契約：[docs/browsers.md](docs/browsers.md)。

## 已可運作（由測試套件驗證）

- **網頁填寫**：依密碼庫項目綁定來源、iframe 內的欄位只能透過明確規則填寫、規劃後頁面若導覽即拒絕輸入、略過蜜罐欄位、等待 SPA、單次送出、填寫後鎖定。
- **欄位規則與登入設定檔**：在項目（`blindfill.rules`）或本機設定檔中為各網站指定精確選擇器，用於啟發式無法辨識的表單。規則選擇器為純 CSS，不含值或狀態探測。
- **頁面工具**：`page discover|diagnose|verify|list` 只回報結構與布林值，絕不回傳內容值；工作階段鎖定時一律拒絕。
- **註冊**：`item generate` 以 CSPRNG 產生密碼並建立項目，密碼不會顯示；`register` 將其輸入綁定來源上的註冊表單（密碼與確認欄位）。
- **項目管理**：`item list|status|rename|edit`。機密值、來源與 `blindfill.*` 欄位只能在終端機中變更。沒有 `item reveal`。
- **人工接手**：`handoff pause|resume` 將瀏覽器交給人處理 CAPTCHA、同意頁或 MFA；期間拒絕代理動作，且恢復後鎖定仍然有效。
- **介面**：CLI、MCP 伺服器（stdio）與函式庫 API（`withPage(page, …)`）。
- **洩漏測試**：填寫、規則、設定檔、頁面工具、註冊、項目管理與人工接手皆透過 CLI 與 MCP 執行，使用 canary 密碼與產生的密碼；所有輸出、錯誤、`DEBUG=pw:api` 日誌與狀態檔案都以原文、URL、Base64 與十六進位形式搜尋。

## 尚未完成

- Android：儲存新登入、WebView 登入。Passkey 計數器回寫與註冊。WebKit。
- `bw` 對真實密碼庫的端到端測試。其餘六個後端為盲寫且未驗證。
- 尚未發布到 npm（`latest` 為空的佔位版本）。
- 從 olliepm 遷移：[docs/MIGRATING-FROM-OLLIEPM.md](docs/MIGRATING-FROM-OLLIEPM.md)。

## 快速試用

```bash
npm ci && npm run build && npx playwright-core install chromium
export BW_SESSION="$(bw unlock --raw)"        # env only
mkdir -p ~/.config/blindfill && echo '{"backend":"bw"}' > ~/.config/blindfill/config.json
node dist/cli.js backend list
node dist/cli.js session start --headless
node dist/cli.js fill --item <id> --url https://example.com/login --submit --expect-url /home
node dist/cli.js mcp                           # MCP server on stdio, see examples/mcp-config.json
```

## 開發

`npm run lint && npm test && npm run build`。架構說明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
發布流程（由 tag 觸發，使用 npm Trusted Publishing）：[docs/RELEASING.md](docs/RELEASING.md)。MIT 授權。

## 翻譯

歡迎提交翻譯 PR：無論是改進現有的 [繁體中文](README.zh-TW.md)、[简体中文](README.zh-CN.md)、[日本語](README.ja.md)、[한국어](README.ko.md)，或新增其他語言。一切以英文版 README 為準。
