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

blindfill 从你的密码管理器读取登录信息，确认它属于该页面的网站，填入真实的表单，只把结果告诉智能体。密码永远不会进入模型的上下文。

> **状态：alpha（0.1.0）。** 尚未经过独立安全审查。用于重要账号前，请先阅读 [SECURITY.md](SECURITY.md)。

## 快速开始

需要 Node 20 及以上，以及默认后端 Bitwarden 的 CLI（`bw`）。

```bash
export BW_SESSION="$(bw unlock --raw)"     # 解锁密码库（只放在环境变量中）
npx -y blindfill session start             # 启动它自己的无头 Chromium
npx blindfill fill --item <id> --url https://example.com/login --submit
```

`<id>` 是密码库条目的 ID（`npx blindfill item list`）。如果 `session start` 提示找不到 Chromium，运行一次
`npx playwright-core install chromium`，或用 `--executable <路径>` 指定你自己的 Chromium。

供智能体使用时，启动 MCP 服务器：`npx -y blindfill mcp`（[配置示例](examples/mcp-config.json)）。每天都用的话：
`npm i -g blindfill`，之后省略 `npx`。

## 它保证什么

- **机密只能填，不能读。** 没有任何命令、MCP 工具或库函数会返回密码、TOTP 种子或私钥。
- **绑定正确的网站。** 机密能填到哪里由密码库条目决定。仿冒域名或跨源 iframe 会在读取任何机密之前就被拒绝。
- **填完即锁定。** 之后页面文本、DOM 和截图一律拒绝提供，所有输出都经过清除。
- **不确定就停下。** 字段不明确或结果未知时只报告，不重试。

## 支持

Bitwarden / Vaultwarden（已在真实网站测试；其他六个后端未验证）· Chromium、Firefox / Camoufox、Ego Lite · passkey ·
TOTP 验证码 · Android 14+ 辅助 app（实验性）· macOS 和 Linux（Windows：仅测试套件）。
各组件状态和每次测试记录：[docs/TESTED.md](docs/TESTED.md)。

## 文档

| 主题               | 文档                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 威胁模型和已知限制 | [SECURITY.md](SECURITY.md)                                                                            |
| 支持状态和测试记录 | [docs/TESTED.md](docs/TESTED.md)                                                                      |
| 连接你自己的浏览器 | [docs/browsers.md](docs/browsers.md)                                                                  |
| 密码管理器配置     | [Bitwarden](docs/backends/bitwarden.md)、[其他](docs/backends/other.md)                               |
| Android 辅助 app   | [android/README.md](android/README.md)                                                                |
| 与其他做法比较     | [docs/COMPARISON.md](docs/COMPARISON.md)                                                              |
| 架构、发布、贡献   | [ARCHITECTURE](docs/ARCHITECTURE.md)、[RELEASING](docs/RELEASING.md)、[CONTRIBUTING](CONTRIBUTING.md) |

文档以英文撰写。

## 开发

`npm ci && npm run lint && npm test && npm run build`，之后使用 `node dist/cli.js …`。MIT 许可。

## 翻译

欢迎提交翻译 PR：无论是改进现有的 [繁體中文](README.zh-TW.md)、[简体中文](README.zh-CN.md)、[日本語](README.ja.md)、[한국어](README.ko.md)，还是新增其他语言。一切以英文版 README 为准。
