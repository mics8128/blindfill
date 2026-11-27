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

| ブラウザ                                                                                    | 状況                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium：Playwright 同梱、任意の Chromium ビルド（`--executable`）、またはループバック CDP | 対応、テスト済み                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Firefox / Camoufox（ループバックの Playwright サーバー経由、`--browser firefox-connect`）   | テスト済み（オプトインのスイート）：Camoufox 158.0.1-beta.41 と 159.0-beta.43。永続プロファイルを持つサーバー（共有の Camoufox など）はそのまま再利用：その cookie とログイン状態を使い、`--url` は自分のタブを開き、既存のタブを移動・クローズしない（[docs/browsers.md](docs/browsers.md)）。長時間稼働するインスタンスで読み取り専用の確認済み                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Ego Lite                                                                                    | 独立した空プロファイルのインスタンス（`--executable`）。実行中のアプリはオプトインで**非サポート**の `ego-cli`（`--endpoint ego://new`）経由のみ：入力値は Ego の Node runtime を通る。2026-11-28 に外部通信と crash dump を確認し漏えいなし。Ego UI の操作ログは未確認（[docs/browsers.md](docs/browsers.md#ego-lite)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| WebKit / Safari                                                                             | 非対応                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Android（14 以降）                                                                          | コンパニオン APK：パスワードは自動入力サービス（ログインと、`item generate` で作ったパスワードによる登録フォーム）、パスワードと passkey は Credential Manager（ログインと、passkey 未登録で App に紐付いた項目への追加のみの passkey 登録。鍵はホスト側で作成・使用）。アプリは Bitwarden と同じくパッケージ名で紐付け、項目に `blindfill.signers` があれば署名も確認。WebView は https ドメインのみで紐付け（SECURITY.md 21–23）。正式署名済みで、ホストは入力のたびに端末上のコンパニオン APK の署名を確認。`blindfill android install --serial <s>` でインストール（[android/README.md](android/README.md)）。偽アプリを使い 1 台（Xperia 5 II、Android 17）とエミュレーター（Android 16）でテスト済み：パスワード、登録フォーム、WebView のログインと登録、Credential Manager のパスワード、passkey 登録とその後のログイン。同じ端末と実 `bw` Vault で実アプリを試験（2026-11-27）：Threads はログイン成功、Instagram は一部のみ（候補は入力済み、ログイン結果は未確認） |
| Passkey                                                                                     | Web ログインと登録（追加のみ：ページに紐付き、passkey をまだ持たない項目ならどれでも）：Chromium と、Marionette 経由の Firefox/Camoufox（`BLINDFILL_MARIONETTE`。Firefox は BE=0 で署名するため、BE を確認するサイトでは Bitwarden 製 passkey が拒否されることがある。その場合は Chromium を使用）。厳格な偽 relying party でテスト済み（Firefox：opt-in テスト、Mac と Linux の Camoufox）。2026-11-27 に `bw` Vault で webauthn.io（Chromium）に 3 回連続ログイン、登録 1 回とその後のログイン、Bitwarden 拡張機能もその blindfill 製 passkey でログイン。カウンターは Vault に書き戻す。github.com（使い捨てアカウント、2026-11-28、Linux の Chromium）：設定から passkey を追加し、新しいセッションで passkey ログイン 2 回、Bitwarden 拡張機能でもログインし、その後 blindfill で再ログイン                                                                                                                                                                              |

**ブラウザの接続。** 何も設定しなければ、`blindfill session start` が自前の Chromium（空のプロファイル）を起動する。起動済みのブラウザを使うには、`~/.config/blindfill/config.json` に `web.endpoint`（`--remote-debugging-port` 付きで起動した Chrome なら `http://127.0.0.1:9222`）か `web.endpointFile`（どのランチャーでも書ける JSON ファイル `{"endpoint": "ws://…"}`）を設定するか、環境変数 `BLINDFILL_ENDPOINT` / `BLINDFILL_ENDPOINT_FILE` を使う。以後 `blindfill session attach` は引数不要。ブラウザごとの制限（Chrome の既定プロファイル、Firefox と Camoufox は Playwright サーバーが必要、Ego Lite は blindfill が起動する空のインスタンスかオプトインの `ego-cli`）：[docs/browsers.md](docs/browsers.md#connecting-a-browser)。

ブラウザプロバイダーとその契約：[docs/browsers.md](docs/browsers.md)。失敗も含む全テスト記録：[docs/TESTED.md](docs/TESTED.md)。

## 動作するもの（テストスイートで検証済み）

- **Web フォーム入力**：保管庫アイテムによるオリジン紐付け、iframe 内のフィールドは明示的なルール経由のみ、計画後にページが遷移したら入力を拒否、ハニーポットのスキップ、SPA の待機、1 回限りの送信、入力後ロック。
- **フィールドルールとログインプロファイル**：ヒューリスティクスで読めないフォーム向けに、サイトごとの正確なセレクターをアイテム（`blindfill.rules`）またはローカルプロファイルで指定。ルールのセレクターは値や状態の探査を含まない純粋な CSS。
- **ページツール**：`page discover|diagnose|verify|list` は構造と真偽値のみを報告し、値は返さない。セッションがロック中は拒否される。
- **登録**：`item generate` は CSPRNG で生成した（表示されない）パスワードを持つアイテムを作成。`register` はそれを紐付け済みオリジンの登録フォーム（パスワードと確認欄）に入力する。`item generate --no-password` はユーザー名だけでパスワードのない項目を作成（passkey のみのサイト向け）。パスワードログイン、`fill`、`register`、`android fill` は空欄を入力せず「パスワードなし」として拒否する。
- **認証アプリ設定**：`totp enroll --item <id> --selector <css>` は紐付け済みページ上の単一要素からセットアップキー（または `otpauth://totp` URI）を読み取り、TOTP シードを持たないアイテムに保存する。キーは表示されず、既存のシードは上書きしない。その後 `totp --fill` でコードを入力する。
- **アイテム管理**：`item list|status|rename|edit`。秘密の値、オリジン、`blindfill.*` フィールドはターミナルでのみ変更できる。ただし `blindfill.rules` はエージェントも変更できる（SECURITY.md 参照）。`item reveal` は存在しない。
- **人への引き継ぎ**：`handoff pause|resume` で CAPTCHA、同意、MFA のためにブラウザを人に渡す。その間エージェントの操作は拒否され、再開後もロックは維持される。
- **インターフェース**：CLI、MCP サーバー（stdio）、ライブラリ API（`withPage(page, …)`）。
- **漏えいテスト**：入力、ルール、プロファイル、ページツール、登録、アイテム管理、引き継ぎを CLI と MCP 経由で、canary パスワードと生成パスワードを使って実行。すべての出力、エラー、`DEBUG=pw:api` ログ、状態ファイルを、生、URL、Base64、16 進の各形式で検索する。

## 未対応

- Android：手入力したログインの保存、実アプリでの登録フォーム・WebView・Credential Manager パスワード、実アプリでの passkey 登録。WebKit。実サイトや常駐 Camoufox での Firefox passkey。
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
