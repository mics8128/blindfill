<div align="center">

# blindfill

**AI 에이전트가 비밀번호를 보지 않고도 웹사이트에 로그인하게 합니다.**

**[웹사이트: mics8128.github.io/blindfill](https://mics8128.github.io/blindfill/)**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

</div>

AI 에이전트가 **비밀번호를 전혀 보지 않고도** 웹사이트에 로그인할 수 있게 합니다. blindfill은 비밀번호 관리자에서 자격 증명을 읽어 페이지의 오리진(origin)에 바인딩되어 있는지 확인한 뒤, 실제 폼에 입력하고 페이지 구조와 결과만 반환합니다. 비밀 값은 쓰기 전용(`SecretHandle.into(sink)`)이며 출력에서 제거(scrub)되고, 입력이 끝나면 세션이 잠깁니다.

> **상태: alpha (0.1.0-alpha.0).** 먼저 [SECURITY.md](SECURITY.md)에서 위협 모델과 알려진 한계를 읽어 보세요.

## 예시: 비밀번호는 LLM을 거치지 않습니다

아래 출력은 예시이며 필드 이름은 조금 다를 수 있습니다.

1. **로그인.** 에이전트가 항목 ID와 로그인 URL로 `fill`을 호출합니다. blindfill은 `bw`에서 비밀번호를 꺼내 폼에 직접 입력하고 `{"ok": true, "url": ".../home"}`만 반환합니다. 모델은 결과만 볼 뿐 비밀번호는 볼 수 없습니다.
2. **피싱과 프롬프트 인젝션.** 비슷하게 만든 도메인(`examp1e.com`)이나 교차 출처 iframe은 **비밀 값을 읽기 전에** 거부됩니다. 악성 페이지가 에이전트를 속여 다른 곳에 비밀번호를 입력하게 만들 수 없습니다.
3. **일회용 코드.** `totp_code`는 현재 6자리 코드를 반환합니다(텍스트처럼 읽기와 입력이 모두 가능). TOTP 시드는 백엔드 밖으로 나가지 않습니다.
4. **입력 후 잠금.** 입력 후 세션은 페이지 텍스트, DOM, 스크린샷 제공을 거부합니다. 페이지가 비밀번호를 되돌려 보여 줘도 모델로 유출되지 않습니다.

## 지원 백엔드와 브라우저

| 백엔드                                                                                        | 등급                                               | 비고                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bitwarden / Vaultwarden(`bw`)                                                                 | 검증됨(모의 CLI + 픽스처, 실제 Vault에서 1회 실행) | 2026-11-27: `tests/live-bw.test.ts`가 실제 Vaultwarden(Bitwarden CLI 2026.11.1)에서 통과. 일회용 항목과 로컬 가짜 페이지 사용(비밀번호 + TOTP 채우기, 생성 + 가입). `bw`로 실제 웹사이트 로그인: 아직 안 함. |
| 1Password(`op`), rbw, pass, gopass, KeePassXC(`keepassxc-cli`), Secret Service(`secret-tool`) | 블라인드 작성, 미검증                              | 픽스처에서 공통 계약 테스트만 통과했습니다. `blindfill backend selftest <id>`를 실행하고 백엔드 리포트를 남겨 주세요.                                                                                        |

| 브라우저                                                                         | 상태                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chromium: Playwright 번들, 임의의 Chromium 빌드(`--executable`), 또는 루프백 CDP | 지원, 테스트됨                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Firefox / Camoufox (루프백 Playwright 서버 경유, `--browser firefox-connect`)    | 테스트됨(옵트인 스위트): Camoufox 158.0.1-beta.41 및 159.0-beta.43. 영구 프로필이 있는 서버(예: 공유 Camoufox)는 그대로 재사용: 그 쿠키와 로그인 상태를 쓰고, `--url`은 자체 탭을 열며, 기존 탭은 이동하거나 닫지 않음([docs/browsers.md](docs/browsers.md)). 장시간 실행 중인 인스턴스에서 읽기 전용 확인                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Ego Lite                                                                         | 별도의 빈 프로필 인스턴스로만 지원(`--executable`). 실행 중인 앱에 연결하는 것은 미지원                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| WebKit / Safari                                                                  | 미지원                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Android(14 이상)                                                                 | 컴패니언 APK: 비밀번호는 자동 완성 서비스(로그인, 그리고 `item generate`로 만든 비밀번호로 가입 양식), 비밀번호와 passkey는 Credential Manager(로그인, 그리고 opt-in 항목에 추가만 하는 passkey 등록; 키는 호스트에서 생성·사용). 앱은 Bitwarden처럼 패키지 이름으로 연결하고, 항목에 `blindfill.signers`가 있으면 서명도 확인. WebView는 https 도메인만으로 연결(SECURITY.md 21–23). 정식 서명되며 호스트가 매번 채우기 전에 기기의 컴패니언 APK 서명을 확인. `blindfill android install --serial <s>`로 설치([android/README.md](android/README.md)). 가짜 앱으로 기기 1대(Xperia 5 II, Android 17)와 에뮬레이터(Android 16)에서 테스트: 비밀번호, 가입 양식, WebView 로그인과 가입, Credential Manager 비밀번호, passkey 등록 후 로그인. 같은 기기와 실제 `bw` Vault로 실제 앱 테스트(2026-11-27): Threads 로그인 성공, Instagram 부분 완료(제안은 채워졌으나 로그인 결과 미확인) |
| Passkey                                                                          | 웹 로그인과 등록(추가만, opt-in 항목): Chromium, 그리고 Marionette를 통한 Firefox/Camoufox(`BLINDFILL_MARIONETTE`; Firefox는 BE=0으로 서명하므로 BE를 확인하는 사이트는 Bitwarden이 만든 passkey를 거부할 수 있음. 그때는 Chromium 사용). 엄격한 가짜 relying party로 테스트(Firefox: opt-in 테스트, Mac과 Linux의 Camoufox). 2026-11-27 `bw` Vault로 webauthn.io(Chromium)에서 연속 로그인 3회, 등록 1회 후 로그인, Bitwarden 확장 프로그램도 그 blindfill 제작 passkey로 로그인. 카운터는 Vault에 기록                                                                                                                                                                                                                                                                                                                                                                             |

브라우저 제공자와 그 계약: [docs/browsers.md](docs/browsers.md). 실패를 포함한 모든 테스트 기록: [docs/TESTED.md](docs/TESTED.md).

## 동작하는 것 (테스트 스위트로 검증됨)

- **웹 입력**: 보관함 항목에 따른 오리진 바인딩, iframe 안의 필드는 명시적 규칙으로만 입력, 계획 후 페이지가 이동하면 입력 거부, 허니팟 건너뛰기, SPA 대기, 1회 제출, 입력 후 잠금.
- **필드 규칙과 로그인 프로필**: 휴리스틱이 읽지 못하는 폼을 위해 사이트별 정확한 셀렉터를 항목(`blindfill.rules`) 또는 로컬 프로필에 지정. 규칙 셀렉터는 값이나 상태 탐색이 없는 순수 CSS.
- **페이지 도구**: `page discover|diagnose|verify|list`는 구조와 불리언만 보고하며 값은 절대 반환하지 않음. 세션이 잠긴 동안은 거부됨.
- **등록**: `item generate`는 표시되지 않는 CSPRNG 비밀번호가 담긴 항목을 생성. `register`는 이를 바인딩된 오리진의 가입 폼(비밀번호와 확인란)에 입력.
- **인증 앱 설정**: `totp enroll --item <id> --selector <css>`는 바인딩된 페이지의 단일 요소에서 설정 키(또는 `otpauth://totp` URI)를 읽어 TOTP 시드가 없는 항목에 저장. 키는 표시되지 않으며 기존 시드는 절대 덮어쓰지 않음. 이후 `totp --fill`로 코드를 입력.
- **항목 관리**: `item list|status|rename|edit`. 비밀 값, 오리진, `blindfill.*` 필드는 터미널에서만 변경 가능. 단, `blindfill.rules`는 에이전트도 변경 가능(SECURITY.md 참조). `item reveal`은 없음.
- **사람에게 인계**: `handoff pause|resume`으로 CAPTCHA, 동의, MFA를 위해 브라우저를 사람에게 넘김. 그동안 에이전트 동작은 거부되고, 재개 후에도 잠금은 유지됨.
- **인터페이스**: CLI, MCP 서버(stdio), 라이브러리 API(`withPage(page, …)`).
- **유출 테스트**: 입력, 규칙, 프로필, 페이지 도구, 등록, 항목 관리, 인계를 CLI와 MCP로 canary 비밀번호와 생성된 비밀번호를 사용해 실행. 모든 출력, 오류, `DEBUG=pw:api` 로그, 상태 파일을 원문, URL, Base64, 16진수 형태로 검색.

## 미완료

- Android: 직접 입력한 로그인 저장, 실제 앱에서의 가입 양식·WebView·Credential Manager 비밀번호, 실제 앱에서의 passkey 등록. WebKit. 실제 사이트나 상시 실행 Camoufox에서의 Firefox passkey.
- `bw`로 실제 웹사이트 로그인(실제 Vault 테스트는 로컬 가짜 페이지 사용). 나머지 여섯 백엔드는 맹목적으로 작성되어 미검증.
- npm에 미게시(`latest`는 빈 플레이스홀더).
- olliepm에서 이전: [docs/MIGRATING-FROM-OLLIEPM.md](docs/MIGRATING-FROM-OLLIEPM.md).

## 사용해 보기

```bash
npm ci && npm run build && npx playwright-core install chromium
export BW_SESSION="$(bw unlock --raw)"        # env only
mkdir -p ~/.config/blindfill && echo '{"backend":"bw"}' > ~/.config/blindfill/config.json
node dist/cli.js backend list
node dist/cli.js session start --headless
node dist/cli.js fill --item <id> --url https://example.com/login --submit --expect-url /home
node dist/cli.js mcp                           # MCP server on stdio, see examples/mcp-config.json
```

## 개발

`npm run lint && npm test && npm run build`. 아키텍처: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
릴리스(태그 트리거, npm Trusted Publishing): [docs/RELEASING.md](docs/RELEASING.md). MIT 라이선스.

## 번역

번역 PR을 환영합니다. 기존 [繁體中文](README.zh-TW.md), [简体中文](README.zh-CN.md), [日本語](README.ja.md), [한국어](README.ko.md)의 개선이나 새로운 언어 추가 모두 좋습니다. 내용이 다를 경우 영어 README를 기준으로 합니다.
