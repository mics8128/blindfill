<div align="center">

# blindfill

**让 AI 智能体登录网站，却永远看不到密码。**

**[网站：mics8128.github.io/blindfill](https://mics8128.github.io/blindfill/)**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

让 AI 智能体登录网站，**却永远看不到密码**。blindfill 会从你的密码管理器读取凭据，确认其绑定于该页面的来源（origin），再将其输入真实的表单，并且只返回页面结构和执行结果。机密值是只写的（`SecretHandle.into(sink)`），输出时会被清除（scrub），并且填写完成后会话（session）即被锁定。

> **状态：alpha（0.1.0-alpha.0）。** 请先阅读 [SECURITY.md](SECURITY.md)，了解威胁模型和已知缺陷。

## 示例：密码不经过 LLM

以下输出仅为示意，字段名称可能略有不同。

1. **登录。** agent 携带条目 ID 和登录网址调用 `fill`。blindfill 从 `bw` 取出密码，直接输入表单，只返回 `{"ok": true, "url": ".../home"}`。模型只看到结果，看不到密码。
2. **钓鱼与提示注入。** 仿冒域名（`examp1e.com`）或跨域 iframe 会在**读取任何机密之前**被拒绝，恶意网页无法诱使 agent 把密码输入到别处。
3. **一次性验证码。** `totp_code` 返回当前的 6 位验证码（可读、可填入，与文本相同）。TOTP 种子永远不离开后端。
4. **填写后锁定。** 填写后，会话会拒绝提供页面文本、DOM 和截图，页面即使回显密码也无法泄露给模型。

## 支持的后端与浏览器

| 后端                                                                                                | 等级                                                 | 说明                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bitwarden / Vaultwarden（`bw`）                                                                     | 已验证（模拟 CLI + 测试数据；真实 Vault 运行过一次） | 2026-11-27：`tests/live-bw.test.ts` 对真实 Vaultwarden（Bitwarden CLI 2026.11.1）通过，使用一次性条目与本机假网页（密码 + TOTP 填充、生成密码 + 注册）。配合 `bw` 登录真实网站：尚未。 |
| 1Password（`op`）、rbw、pass、gopass、KeePassXC（`keepassxc-cli`）、Secret Service（`secret-tool`） | 盲写、未验证                                         | 仅在测试数据上通过共用契约测试。欢迎运行 `blindfill backend selftest <id>` 并提交后端反馈。                                                                                            |

| 浏览器                                                                            | 状态                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium：Playwright 内置、任意 Chromium 构建（`--executable`），或本机回环 CDP   | 支持，已测试                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Firefox / Camoufox，通过本机回环 Playwright 服务器（`--browser firefox-connect`） | 已测试（可选测试套件），版本为 Camoufox 158.0.1-beta.41 和 159.0-beta.43；长时间运行的实例未测试                                                                                                                                                                                                                                                                                                                              |
| Ego Lite                                                                          | 仅限独立、空白配置文件的实例（`--executable`）；不支持连接正在运行的应用                                                                                                                                                                                                                                                                                                                                                      |
| WebKit / Safari                                                                   | 不支持                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Android（14 以上）                                                                | 辅助 APK：密码走自动填充服务，passkey 走凭据提供程序（在主机端签名）；正式签名，每次填充前主机都会核对手机上 APK 的签名；用 `blindfill android install --serial <s>` 安装（[android/README.md](android/README.md)）；已用假 app 在一部手机（Xperia 5 II，Android 17）和模拟器（Android 16）测试。同一部手机配合真实 `bw` Vault 测试真实 app（2026-11-27）：Threads 登录成功；Instagram 部分完成（建议已填充，未确认登录结果） |
| Passkey                                                                           | 网页登录与注册（只新增、需 opt-in 的条目），仅 Chromium（以严格的假 relying party 测试；2026-11-27 以 `bw` Vault 在 webauthn.io 连续登录三次，并注册一次后登录）；计数器会回写 Vault                                                                                                                                                                                                                                          |

浏览器提供者及其契约：[docs/browsers.md](docs/browsers.md)。每次测试记录（含失败）：[docs/TESTED.md](docs/TESTED.md)。

## 已可运行（由测试套件验证）

- **网页填写**：按密码库条目绑定来源、iframe 内的字段只能通过明确规则填写、规划后页面若发生导航即拒绝输入、跳过蜜罐字段、等待 SPA、单次提交、填写后锁定。
- **字段规则与登录配置**：在条目（`blindfill.rules`）或本地配置中为各站点指定精确选择器，用于启发式无法识别的表单。规则选择器为纯 CSS，不含值或状态探测。
- **页面工具**：`page discover|diagnose|verify|list` 只报告结构和布尔值，绝不返回内容值；会话锁定时一律拒绝。
- **注册**：`item generate` 用 CSPRNG 生成密码并创建条目，密码不会显示；`register` 将其输入绑定来源上的注册表单（密码和确认字段）。
- **验证器设置**：`totp enroll --item <id> --selector <css>` 从绑定网页上的单个元素读取设置密钥（或 `otpauth://totp` URI），保存到尚无 TOTP 种子的条目；密钥不会显示，已有种子绝不覆盖。之后用 `totp --fill` 填入验证码。
- **条目管理**：`item list|status|rename|edit`。机密值、来源和 `blindfill.*` 字段只能在终端中修改。没有 `item reveal`。
- **人工接管**：`handoff pause|resume` 把浏览器交给人处理 CAPTCHA、授权页或 MFA；期间拒绝代理操作，恢复后锁定仍然有效。
- **接口**：CLI、MCP 服务器（stdio）和库 API（`withPage(page, …)`）。
- **泄漏测试**：填写、规则、配置、页面工具、注册、条目管理和人工接管均通过 CLI 和 MCP 运行，使用 canary 密码和生成的密码；所有输出、错误、`DEBUG=pw:api` 日志和状态文件都以原文、URL、Base64 和十六进制形式搜索。

## 尚未完成

- Android：保存新登录、WebView 登录、passkey 注册。WebKit。Firefox/Camoufox 的 passkey。
- `bw` 登录真实网站（真实 Vault 测试使用的是本机假网页）。其余六个后端为盲写且未验证。
- 尚未发布到 npm（`latest` 为空占位版本）。
- 从 olliepm 迁移：[docs/MIGRATING-FROM-OLLIEPM.md](docs/MIGRATING-FROM-OLLIEPM.md)。

## 快速试用

```bash
npm ci && npm run build && npx playwright-core install chromium
export BW_SESSION="$(bw unlock --raw)"        # env only
mkdir -p ~/.config/blindfill && echo '{"backend":"bw"}' > ~/.config/blindfill/config.json
node dist/cli.js backend list
node dist/cli.js session start --headless
node dist/cli.js fill --item <id> --url https://example.com/login --submit --expect-url /home
node dist/cli.js mcp                           # MCP server on stdio, see examples/mcp-config.json
```

## 开发

`npm run lint && npm test && npm run build`。架构说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
发布流程（由 tag 触发，使用 npm Trusted Publishing）：[docs/RELEASING.md](docs/RELEASING.md)。MIT 许可。

## 翻译

欢迎提交翻译 PR：无论是改进现有的 [繁體中文](README.zh-TW.md)、[简体中文](README.zh-CN.md)、[日本語](README.ja.md)、[한국어](README.ko.md)，还是新增其他语言。一切以英文版 README 为准。
