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

| 後端                                                                                                | 等級                                               | 說明                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bitwarden / Vaultwarden（`bw`）                                                                     | 已驗證（模擬 CLI + 測試資料；真實 Vault 跑過一次） | 2026-11-27：`tests/live-bw.test.ts` 對真實 Vaultwarden（Bitwarden CLI 2026.11.1）通過，用拋棄式項目與本機假網頁（密碼 + TOTP 填入、產生密碼 + 註冊）。搭配 `bw` 登入真實網站：尚未。 |
| 1Password（`op`）、rbw、pass、gopass、KeePassXC（`keepassxc-cli`）、Secret Service（`secret-tool`） | 盲寫、未驗證                                       | 僅在測試資料上通過共用契約測試。歡迎執行 `blindfill backend selftest <id>` 並提交後端回報。                                                                                          |

| 瀏覽器                                                                            | 狀態                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium：Playwright 內建、任何 Chromium 組建（`--executable`），或本機回環 CDP   | 支援，已測試                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Firefox / Camoufox，透過本機回環 Playwright 伺服器（`--browser firefox-connect`） | 已測試（選用測試套件），版本為 Camoufox 158.0.1-beta.41 與 159.0-beta.43。有持久設定檔的伺服器（例如共用的 Camoufox）直接沿用：用它的 cookie 與登入狀態，`--url` 另開自己的分頁，既有分頁不會被導覽或關閉（[docs/browsers.md](docs/browsers.md)）；已對長時間執行的實例做唯讀檢查                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Ego Lite                                                                          | 支援：執行中的應用程式透過 `ego-cli`（`--endpoint ego://new`），或獨立、空白設定檔的實例（`--executable`）。使用 `ego-cli` 時，填入的值會經過 Ego 的 Node runtime；跨來源 iframe 看不到（其中的欄位會被拒絕）；不支援 passkey；送出後 Ego 的密碼管理員會執行 Google 的密碼外洩檢查。外送流量與 crash dump 只在 2026-11-28 檢查過一次（約 3 分鐘、假登入頁），未發現外洩；更長時間的流量與 Ego UI 操作紀錄未檢查，擁有者已接受。已在假網站跑過 e2e，真站登入待測（[docs/browsers.md](docs/browsers.md#ego-lite)）                                                                                                                                                                                                                                                                                   |
| WebKit / Safari                                                                   | 不支援                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Android（14 以上）                                                                | 輔助 APK：密碼走自動填入服務（登入，以及用 `item generate` 產生的密碼填註冊表單），密碼與 passkey 走 Credential Manager（登入，以及對綁定該 app、尚無 passkey 的項目只新增的 passkey 註冊；金鑰在主機端產生與使用）；app 與 Bitwarden 一樣依套件名稱綁定，項目有 `blindfill.signers` 時也核對簽章；WebView 只依 https 網域綁定（見 SECURITY.md 21–23）；正式簽章，每次填入前主機都會核對手機上輔助 APK 的簽章；以 `blindfill android install --serial <s>` 安裝（[android/README.md](android/README.md)）；已用假 app 在一支手機（Xperia 5 II，Android 17）與模擬器（Android 16）測試：密碼、註冊表單、WebView 登入與註冊、Credential Manager 密碼、passkey 註冊後登入。同一支手機搭配真實 `bw` Vault 測真實 app（2026-11-27）：Threads 登入成功；Instagram 部分完成（建議已填入，未確認登入結果） |
| Passkey                                                                           | 網頁登入與註冊（只新增：任何綁定該網頁、尚無 passkey 的項目）：Chromium，以及透過 Marionette 的 Firefox/Camoufox（`BLINDFILL_MARIONETTE`；Firefox 以 BE=0 簽署，檢查 BE 的網站可能拒絕 Bitwarden 建立的 passkey，此時改用 Chromium）。以嚴格的假 relying party 測試（Firefox：opt-in 測試，Mac 與 Linux 上的 Camoufox）；2026-11-27 以 `bw` Vault 在 webauthn.io（Chromium）連續登入三次、註冊一次後登入，Bitwarden 擴充套件也能用這個 blindfill 建立的 passkey 登入；計數器會回寫 Vault；github.com（拋棄式帳號，2026-11-28，Linux 上的 Chromium）：從設定新增 passkey，再在新 session 用 passkey 登入兩次，Bitwarden 擴充套件也用它登入，之後 blindfill 再登入一次                                                                                                                               |

**接上瀏覽器。** 什麼都不設定時，`blindfill session start` 會自己開一個 Chromium（空的設定檔）。要用你已在執行的瀏覽器，在 `~/.config/blindfill/config.json` 設定 `web.endpoint`（以 `--remote-debugging-port` 啟動的 Chrome 為 `http://127.0.0.1:9222`）或 `web.endpointFile`（任何啟動器都能寫的 JSON 檔 `{"endpoint": "ws://…"}`），或用環境變數 `BLINDFILL_ENDPOINT` / `BLINDFILL_ENDPOINT_FILE`；之後 `blindfill session attach` 不必帶參數。各瀏覽器的限制（Chrome 的預設設定檔、Firefox 與 Camoufox 需要 Playwright 伺服器、Ego Lite 由 blindfill 自己開空的實例或透過 `ego-cli`）：[docs/browsers.md](docs/browsers.md#connecting-a-browser)。

**平台。** macOS 與 Linux。Windows 10/11：測試套件（單元、洩漏與本機假頁 e2e，Chromium）在一台 Windows 11 電腦上通過，每次發布前也在 `windows-latest` 執行；**Windows 上的真實網站尚未測試**。Windows 上狀態、設定與設定檔資料夾改以 ACL 檢查，取代 0700/0600 權限（見 SECURITY.md）；`bw` 請安裝原生 `bw.exe`（scoop 的 `bitwarden-cli` 或 Bitwarden 官方獨立下載），npm 的 `bw.cmd` 不經 shell 無法啟動；`ego-cli` 提供者不支援 Windows。

瀏覽器提供者及其契約：[docs/browsers.md](docs/browsers.md)。每次測試紀錄（含失敗）：[docs/TESTED.md](docs/TESTED.md)。

## 已可運作（由測試套件驗證）

- **網頁填寫**：依密碼庫項目綁定來源、iframe 內的欄位只能透過明確規則填寫、規劃後頁面若導覽即拒絕輸入、略過蜜罐欄位、等待 SPA、單次送出、填寫後鎖定。
- **欄位規則與登入設定檔**：在項目（`blindfill.rules`）或本機設定檔中為各網站指定精確選擇器，用於啟發式無法辨識的表單。規則選擇器為純 CSS，不含值或狀態探測。
- **頁面工具**：`page discover|diagnose|verify|list` 只回報結構與布林值，絕不回傳內容值；工作階段鎖定時一律拒絕。
- **註冊**：`item generate` 以 CSPRNG 產生密碼並建立項目，密碼不會顯示；`register` 將其輸入綁定來源上的註冊表單（密碼與確認欄位）。`item generate --no-password` 建立只有使用者名稱、沒有密碼的項目，給只用 passkey 註冊的網站；密碼登入、`fill`、`register` 與 `android fill` 會明確回報「沒有密碼」並拒絕，不會填入空白。
- **驗證器設定**：`totp enroll --item <id> --selector <css>` 從綁定網頁上的單一元素讀出設定金鑰（或 `otpauth://totp` URI），存進尚無 TOTP 種子的項目；金鑰不會顯示，既有種子絕不覆蓋。之後用 `totp --fill` 填入驗證碼。
- **項目管理**：`item list|status|rename|edit`。機密值、來源與 `blindfill.*` 欄位只能在終端機中變更，唯一例外是 `blindfill.rules`，代理可以修改（見 SECURITY.md）。沒有 `item reveal`。
- **人工接手**：`handoff pause|resume` 將瀏覽器交給人處理 CAPTCHA、同意頁或 MFA；期間拒絕代理動作，且恢復後鎖定仍然有效。
- **介面**：CLI、MCP 伺服器（stdio）與函式庫 API（`withPage(page, …)`）。
- **洩漏測試**：填寫、規則、設定檔、頁面工具、註冊、項目管理與人工接手皆透過 CLI 與 MCP 執行，使用 canary 密碼與產生的密碼；所有輸出、錯誤、`DEBUG=pw:api` 日誌與狀態檔案都以原文、URL、Base64 與十六進位形式搜尋。

## 尚未完成

- Android：儲存手動輸入的登入、在真實 app 中的註冊表單、WebView 與 Credential Manager 密碼、在真實 app 中註冊 passkey。WebKit。Firefox passkey 在真實網站或長期執行的 Camoufox 上使用。
- `bw` 登入真實網站（真實 Vault 測試用的是本機假網頁）。其餘六個後端為盲寫且未驗證。
- 尚未發布到 npm（`latest` 為空的佔位版本）。

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
