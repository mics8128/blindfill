<div align="center">

# blindfill

**讓 AI 代理登入網站，卻永遠看不到密碼。**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

讓 AI 代理登入網站，**卻永遠看不到密碼**。blindfill 會從你的密碼管理器讀取憑證，確認它綁定於該頁面的來源（origin），再將其輸入真實的表單，並且只回傳頁面結構與執行結果。機密值是唯寫的（`SecretHandle.into(sink)`），輸出時會被清除（scrub），且填寫完成後工作階段（session）即鎖定。

> **狀態：alpha（0.1.0-alpha.0）。** 請先閱讀 [SECURITY.md](SECURITY.md)，了解威脅模型與已知缺口。

## 已可運作（由測試套件驗證）

- Web actuator（Playwright + Chromium）：來源綁定、拒絕跨來源 iframe、略過蜜罐（honeypot）欄位、等待 SPA 渲染、按鍵事件備援、單次送出、填寫後鎖定。
- Bitwarden `bw` 後端（以模擬 CLI 與測試資料驗證），另有六個後端屬於**盲寫且未經驗證**（見 `docs/backends/`）。
- CLI 與 MCP 伺服器（stdio）。洩漏測試會以 canary 密碼掃描所有輸出與狀態檔案。

## 尚未完成

- Android actuator（僅為會拋出錯誤的 stub）。所有後端都尚未以真實保險庫驗證。尚未發布。尚不支援 passkey。

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
