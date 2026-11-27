<div align="center">

# blindfill

**AI エージェントにパスワードを見せずに、Web サイトへサインインさせる。**

**[Web サイト：mics8128.github.io/blindfill](https://mics8128.github.io/blindfill/)**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

</div>

blindfill はパスワードマネージャーからログイン情報を読み取り、それがページのサイトのものであることを確認してから実際のフォームに入力し、エージェントには結果だけを返します。パスワードがモデルのコンテキストに入ることはありません。

> **ステータス: alpha。** 独立したセキュリティレビューはまだ受けていません。重要なアカウントで使う前に [SECURITY.md](SECURITY.md) をお読みください。

## クイックスタート

Node 20 以上と、デフォルトのバックエンドである Bitwarden の CLI（`bw`）が必要です。

```bash
export BW_SESSION="$(bw unlock --raw)"     # 保管庫をアンロック（環境変数のみ）
npx -y blindfill session start             # 専用のヘッドレス Chromium を起動
npx blindfill fill --item <id> --url https://example.com/login --submit
```

`<id>` は保管庫アイテムの ID です（`npx blindfill item list`）。`session start` が Chromium が見つからないと報告したら、
`npx playwright-core install chromium` を一度実行するか、`--executable <パス>` で手持ちの Chromium を指定してください。

エージェントから使うには MCP サーバーを起動します: `npx -y blindfill mcp`（[設定例](examples/mcp-config.json)）。
毎日使うなら `npm i -g blindfill` で、以後 `npx` は不要です。

## 保証すること

- **シークレットは入力専用。** パスワード、TOTP シード、秘密鍵を返すコマンド、MCP ツール、ライブラリ関数はありません。
- **正しいサイトに紐づく。** シークレットをどこに入力できるかは保管庫アイテムが決めます。似たドメインやクロスオリジンの iframe は、シークレットを読む前に拒否されます。
- **入力後はロック。** 以後ページのテキスト、DOM、スクリーンショットは拒否され、すべての出力が除去処理されます。
- **推測せずに止まる。** あいまいなフィールドや不明な結果は報告するだけで、再試行しません。

## 対応状況

Bitwarden / Vaultwarden（実サイトでテスト済み、他の 6 バックエンドは未検証）· Chromium、Firefox / Camoufox、Ego Lite ·
パスキー · TOTP コード · Android 14+ コンパニオンアプリ（実験的）· macOS と Linux（Windows はテストスイートのみ）。
各コンポーネントの状況とすべてのテスト記録: [docs/TESTED.md](docs/TESTED.md)。

## ドキュメント

| トピック                       | ドキュメント                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 脅威モデルと既知の制約         | [SECURITY.md](SECURITY.md)                                                                            |
| 対応状況とテスト記録           | [docs/TESTED.md](docs/TESTED.md)                                                                      |
| 自分のブラウザに接続する       | [docs/browsers.md](docs/browsers.md)                                                                  |
| パスワードマネージャーの設定   | [Bitwarden](docs/backends/bitwarden.md)、[その他](docs/backends/other.md)                             |
| Android コンパニオンアプリ     | [android/README.md](android/README.md)                                                                |
| 他の方法との比較               | [docs/COMPARISON.md](docs/COMPARISON.md)                                                              |
| アーキテクチャ、リリース、貢献 | [ARCHITECTURE](docs/ARCHITECTURE.md)、[RELEASING](docs/RELEASING.md)、[CONTRIBUTING](CONTRIBUTING.md) |

ドキュメントは英語です。

## 開発

`npm ci && npm run lint && npm test && npm run build`、その後 `node dist/cli.js …`。MIT ライセンス。

## 翻訳

翻訳の PR を歓迎します。既存の [繁體中文](README.zh-TW.md)、[简体中文](README.zh-CN.md)、[日本語](README.ja.md)、[한국어](README.ko.md) の改善や、新しい言語の追加をお待ちしています。内容に差異がある場合は英語版 README を正とします。
