<div align="center">

# blindfill

**AI エージェントにパスワードを見せずに、Web サイトへサインインさせる。**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

</div>

AI エージェントを、**パスワードを一切見せることなく**Web サイトへサインインさせます。blindfill はパスワードマネージャーから認証情報を読み取り、それがページのオリジン（origin）に紐づいていることを確認したうえで、実際のフォームに入力し、ページの構造と結果だけを返します。シークレットの値は書き込み専用（`SecretHandle.into(sink)`）で、出力からは除去（scrub）され、入力後はセッションがロックされます。

> **ステータス: alpha（0.1.0-alpha.0）。** 脅威モデルと既知の制約について、まず [SECURITY.md](SECURITY.md) をお読みください。

## 例：パスワードは LLM を通らない

以下の出力はイメージです。フィールド名は多少異なる場合があります。

1. **サインイン。** エージェントがアイテム ID とログイン URL を指定して `fill` を呼びます。blindfill は `bw` からパスワードを取り出してフォームに直接入力し、`{"ok": true, "url": ".../home"}` だけを返します。モデルが見るのは結果だけで、パスワードは見えません。
2. **フィッシングとプロンプトインジェクション。** 紛らわしいドメイン（`examp1e.com`）やクロスオリジンの iframe は、**シークレットを読み取る前に**拒否されます。悪意あるページがエージェントを誘導して別の場所へパスワードを入力させることはできません。
3. **ワンタイムコード。** `totp_code` は現在の 6 桁コードを返します（テキストと同様に読み取りも入力も可能）。TOTP シードがバックエンドの外に出ることはありません。
4. **入力後のロック。** 入力後、セッションはページのテキスト、DOM、スクリーンショットの提供を拒否します。ページがパスワードをエコーしてもモデルには漏れません。

## 対応バックエンドとブラウザ

| バックエンド                                                                                        | 区分                                  | 備考                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Bitwarden / Vaultwarden（`bw`）                                                                     | 検証済み（モック CLI + フィクスチャ） | アイテム JSON の形式は実際の Vaultwarden でも手動で確認済み。実 Vault での blindfill のエンドツーエンド検証は未実施。                        |
| 1Password（`op`）、rbw、pass、gopass、KeePassXC（`keepassxc-cli`）、Secret Service（`secret-tool`） | 手探り実装・未検証                    | フィクスチャ上で共通コントラクトテストに合格しているのみ。`blindfill backend selftest <id>` を実行してバックエンドレポートをお寄せください。 |

| 対象                                                                | 状況             |
| ------------------------------------------------------------------- | ---------------- |
| Chromium（Playwright 同梱、またはループバック CDP 経由の Chromium） | 対応・テスト済み |
| Firefox / Camoufox、WebKit/Safari                                   | 未対応           |
| Android                                                             | 未実装（スタブ） |
| Passkey                                                             | 未対応           |

## 動作するもの（テストスイートで検証済み）

- Web アクチュエーター（Playwright + Chromium）: オリジン束縛、クロスオリジン iframe の拒否、ハニーポット（honeypot）のスキップ、SPA の描画待機、キーイベントによるフォールバック、1 回限りの送信、入力後のロック。
- Bitwarden `bw` バックエンド（モック CLI とフィクスチャで検証）。ほかに、**手探りで書かれ未検証**のバックエンドが 6 つあります（`docs/backends/` を参照）。
- CLI と MCP サーバー（stdio）。リークテストが、canary パスワードをすべての出力と状態ファイルから検索します。

## 未対応

- Android アクチュエーター（例外を投げるだけのスタブ）。どのバックエンドも実際のボールトでは未検証。未公開。パスキー（passkey）は未対応。

## 試してみる

```bash
npm ci && npm run build && npx playwright-core install chromium
export BW_SESSION="$(bw unlock --raw)"        # env only
mkdir -p ~/.config/blindfill && echo '{"backend":"bw"}' > ~/.config/blindfill/config.json
node dist/cli.js backend list
node dist/cli.js session start --headless
node dist/cli.js fill --item <id> --url https://example.com/login --submit --expect-url /home
node dist/cli.js mcp                           # MCP server on stdio, see examples/mcp-config.json
```

## 開発

`npm run lint && npm test && npm run build`。アーキテクチャ: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
リリース手順（タグ起動、npm Trusted Publishing）: [docs/RELEASING.md](docs/RELEASING.md)。MIT ライセンス。

## 翻訳

翻訳の PR を歓迎します。既存の [繁體中文](README.zh-TW.md)、[简体中文](README.zh-CN.md)、[日本語](README.ja.md)、[한국어](README.ko.md) の改善や、新しい言語の追加をお待ちしています。内容に差異がある場合は英語版 README を正とします。
