<div align="center">

# blindfill

**让 AI 智能体登录网站，却永远看不到密码。**

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

| 后端                                                                                                | 等级                          | 说明                                                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Bitwarden / Vaultwarden（`bw`）                                                                     | 已验证（模拟 CLI + 测试数据） | 条目 JSON 格式另经人工对照真实 Vaultwarden。blindfill 对真实 Vault 的端到端测试：尚未。     |
| 1Password（`op`）、rbw、pass、gopass、KeePassXC（`keepassxc-cli`）、Secret Service（`secret-tool`） | 盲写、未验证                  | 仅在测试数据上通过共用契约测试。欢迎运行 `blindfill backend selftest <id>` 并提交后端反馈。 |

| 目标                                                        | 状态           |
| ----------------------------------------------------------- | -------------- |
| Chromium（Playwright 内置，或通过本机 CDP 连接的 Chromium） | 支持，已测试   |
| Firefox / Camoufox、WebKit/Safari                           | 暂不支持       |
| Android                                                     | 未实现（占位） |
| Passkey                                                     | 不支持         |

## 已可运行（由测试套件验证）

- Web actuator（Playwright + Chromium）：来源绑定、拒绝跨源 iframe、跳过蜜罐（honeypot）字段、等待 SPA 渲染、按键事件兜底、单次提交、填写后锁定。
- Bitwarden `bw` 后端（基于模拟 CLI 与测试数据验证），另有六个后端属于**盲写且未经验证**（见 `docs/backends/`）。
- CLI 与 MCP 服务器（stdio）。泄漏测试会用 canary 密码扫描所有输出和状态文件。

## 尚未完成

- Android actuator（仅为会抛出错误的 stub）。所有后端都尚未用真实密码库验证。尚未发布。暂不支持 passkey。

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
