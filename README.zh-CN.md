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
