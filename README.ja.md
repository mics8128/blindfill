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

AI エージェントを、**パスワードを一切見せることなく**Web サイトへサインインさせます。blindfill はパスワードマネージャーから認証情報を読み取り、それがページのオリジン（origin）に紐づいていることを確認したうえで、実際のフォームに入力し、ページの構造と結果だけを返します。シークレットの値は書き込み専用（`SecretHandle.into(sink)`）で、出力からは除去（scrub）され、入力後はセッションがロックされます。

> **ステータス: alpha（0.1.0-alpha.0）。** 脅威モデルと既知の制約について、まず [SECURITY.md](SECURITY.md) をお読みください。

## 例：パスワードは LLM を通らない

以下の出力はイメージです。フィールド名は多少異なる場合があります。

1. **サインイン。** エージェントがアイテム ID とログイン URL を指定して `fill` を呼びます。blindfill は `bw` からパスワードを取り出してフォームに直接入力し、`{"ok": true, "url": ".../home"}` だけを返します。モデルが見るのは結果だけで、パスワードは見えません。
2. **フィッシングとプロンプトインジェクション。** 紛らわしいドメイン（`examp1e.com`）やクロスオリジンの iframe は、**シークレットを読み取る前に**拒否されます。悪意あるページがエージェントを誘導して別の場所へパスワードを入力させることはできません。
3. **ワンタイムコード。** `totp_code` は現在の 6 桁コードを返します（テキストと同様に読み取りも入力も可能）。TOTP シードがバックエンドの外に出ることはありません。
4. **入力後のロック。** 入力後、セッションはページのテキスト、DOM、スクリーンショットの提供を拒否します。ページがパスワードをエコーしてもモデルには漏れません。

## 対応バックエンドとブラウザ

| バックエンド                                                                                        | 区分                                                        | 備考                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bitwarden / Vaultwarden（`bw`）                                                                     | 検証済み（モック CLI + フィクスチャ、実 Vault で 1 回実行） | 2026-11-27：`tests/live-bw.test.ts` が実際の Vaultwarden（Bitwarden CLI 2026.11.1）で合格。使い捨てアイテムとローカルの偽ページを使用（パスワード + TOTP の入力、生成 + 登録）。`bw` を使った実在サイトへのログイン：未実施。 |
| 1Password（`op`）、rbw、pass、gopass、KeePassXC（`keepassxc-cli`）、Secret Service（`secret-tool`） | 手探り実装・未検証                                          | フィクスチャ上で共通コントラクトテストに合格しているのみ。`blindfill backend selftest <id>` を実行してバックエンドレポートをお寄せください。                                                                                  |

| ブラウザ                                                                                    | 状況                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium：Playwright 同梱、任意の Chromium ビルド（`--executable`）、またはループバック CDP | 対応、テスト済み                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Firefox / Camoufox（ループバックの Playwright サーバー経由、`--browser firefox-connect`）   | テスト済み（オプトインのスイート）：Camoufox 158.0.1-beta.41 と 159.0-beta.43。長時間稼働するインスタンスは未テスト                                                                                                                                                                                                                                                                                                                                                                                        |
| Ego Lite                                                                                    | 独立した空プロファイルのインスタンスのみ（`--executable`）。実行中のアプリへの接続は非対応                                                                                                                                                                                                                                                                                                                                                                                                                 |
| WebKit / Safari                                                                             | 非対応                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Android（14 以降）                                                                          | コンパニオン APK：パスワードは自動入力サービス、passkey は認証情報プロバイダー（署名はホスト側）。正式署名済みで、ホストは入力のたびに端末上の APK の署名を確認。`blindfill android install --serial <s>` でインストール（[android/README.md](android/README.md)）。偽アプリを使い 1 台（Xperia 5 II、Android 17）とエミュレーター（Android 16）でテスト済み。同じ端末と実 `bw` Vault で実アプリを試験（2026-11-27）：Threads はログイン成功、Instagram は一部のみ（候補は入力済み、ログイン結果は未確認） |
| Passkey                                                                                     | Web ログインのみ、Chromium のみ（偽の relying party でテスト済み）。カウンターの書き戻しと登録は非対応                                                                                                                                                                                                                                                                                                                                                                                                     |

ブラウザプロバイダーとその契約：[docs/browsers.md](docs/browsers.md)。失敗も含む全テスト記録：[docs/TESTED.md](docs/TESTED.md)。

## 動作するもの（テストスイートで検証済み）

- **Web フォーム入力**：保管庫アイテムによるオリジン紐付け、iframe 内のフィールドは明示的なルール経由のみ、計画後にページが遷移したら入力を拒否、ハニーポットのスキップ、SPA の待機、1 回限りの送信、入力後ロック。
- **フィールドルールとログインプロファイル**：ヒューリスティクスで読めないフォーム向けに、サイトごとの正確なセレクターをアイテム（`blindfill.rules`）またはローカルプロファイルで指定。ルールのセレクターは値や状態の探査を含まない純粋な CSS。
- **ページツール**：`page discover|diagnose|verify|list` は構造と真偽値のみを報告し、値は返さない。セッションがロック中は拒否される。
- **登録**：`item generate` は CSPRNG で生成した（表示されない）パスワードを持つアイテムを作成。`register` はそれを紐付け済みオリジンの登録フォーム（パスワードと確認欄）に入力する。
- **アイテム管理**：`item list|status|rename|edit`。秘密の値、オリジン、`blindfill.*` フィールドはターミナルでのみ変更できる。`item reveal` は存在しない。
- **人への引き継ぎ**：`handoff pause|resume` で CAPTCHA、同意、MFA のためにブラウザを人に渡す。その間エージェントの操作は拒否され、再開後もロックは維持される。
- **インターフェース**：CLI、MCP サーバー（stdio）、ライブラリ API（`withPage(page, …)`）。
- **漏えいテスト**：入力、ルール、プロファイル、ページツール、登録、アイテム管理、引き継ぎを CLI と MCP 経由で、canary パスワードと生成パスワードを使って実行。すべての出力、エラー、`DEBUG=pw:api` ログ、状態ファイルを、生、URL、Base64、16 進の各形式で検索する。

## 未対応

- Android：新しいログインの保存、WebView ログイン。Passkey のカウンター書き戻しと登録。WebKit。
- `bw` を使った実在サイトへのログイン（実 Vault のテストはローカルの偽ページ）。他の 6 バックエンドは盲検で書かれており未検証。
- npm には未公開（`latest` は空のプレースホルダー）。
- olliepm からの移行：[docs/MIGRATING-FROM-OLLIEPM.md](docs/MIGRATING-FROM-OLLIEPM.md)。

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
