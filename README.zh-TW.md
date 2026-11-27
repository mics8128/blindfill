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

blindfill 從你的密碼管理器讀出登入資料，確認它屬於該頁面的網站，填進真正的表單，只把結果告訴代理。密碼永遠不會進入模型的上下文。

> **狀態：alpha。** 尚未經過獨立資安審查。用在重要帳號前，請先讀 [SECURITY.md](SECURITY.md)。

## 快速開始

需要 Node 20 以上，以及預設後端 Bitwarden 的 CLI（`bw`）。

```bash
export BW_SESSION="$(bw unlock --raw)"     # 解鎖密碼庫（只放在環境變數）
npx -y blindfill session start             # 啟動它自己的無頭 Chromium
npx blindfill fill --item <id> --url https://example.com/login --submit
```

`<id>` 是密碼庫項目的 ID（`npx blindfill item list`）。如果 `session start` 回報找不到 Chromium，執行一次
`npx playwright-core install chromium`，或用 `--executable <路徑>` 指定自己的 Chromium。

給代理使用時，啟動 MCP 伺服器：`npx -y blindfill mcp`（[設定範例](examples/mcp-config.json)）。天天用的話：
`npm i -g blindfill`，之後省略 `npx`。

## 它保證什麼

- **機密只能填，不能讀。** 沒有任何指令、MCP 工具或函式庫呼叫會回傳密碼、TOTP 種子或私鑰。
- **綁定正確的網站。** 機密能填在哪裡由密碼庫項目決定。仿冒網域或跨來源 iframe 會在讀取任何機密之前就被拒絕。
- **填完即上鎖。** 之後頁面文字、DOM 與截圖一律拒絕提供，所有輸出都經過遮蔽。
- **不確定就停下。** 欄位不明確或結果不明時只回報，不重試。

## 支援

Bitwarden / Vaultwarden（已在真實網站測試；其他六個後端未驗證）· Chromium、Firefox / Camoufox、Ego Lite · passkey ·
TOTP 驗證碼 · Android 14+ 輔助 app（實驗性）· macOS 與 Linux（Windows：僅測試套件）。
各元件狀態與每次測試紀錄：[docs/TESTED.md](docs/TESTED.md)。

## 文件

| 主題               | 文件                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 威脅模型與已知限制 | [SECURITY.md](SECURITY.md)                                                                            |
| 支援狀態與測試紀錄 | [docs/TESTED.md](docs/TESTED.md)                                                                      |
| 連接你自己的瀏覽器 | [docs/browsers.md](docs/browsers.md)                                                                  |
| 密碼管理器設定     | [Bitwarden](docs/backends/bitwarden.md)、[其他](docs/backends/other.md)                               |
| Android 輔助 app   | [android/README.md](android/README.md)                                                                |
| 與其他做法比較     | [docs/COMPARISON.md](docs/COMPARISON.md)                                                              |
| 架構、發布、貢獻   | [ARCHITECTURE](docs/ARCHITECTURE.md)、[RELEASING](docs/RELEASING.md)、[CONTRIBUTING](CONTRIBUTING.md) |

文件以英文撰寫。

## 開發

`npm ci && npm run lint && npm test && npm run build`，之後用 `node dist/cli.js …`。MIT 授權。

## 翻譯

歡迎提交翻譯 PR：無論是改進現有的 [繁體中文](README.zh-TW.md)、[简体中文](README.zh-CN.md)、[日本語](README.ja.md)、[한국어](README.ko.md)，或新增其他語言。一切以英文版 README 為準。
