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

blindfill은 비밀번호 관리자에서 로그인 정보를 읽어, 그것이 페이지의 사이트에 속하는지 확인한 뒤 실제 폼에 입력하고 에이전트에게는 결과만 알려 줍니다. 비밀번호는 모델의 컨텍스트에 들어가지 않습니다.

> **상태: alpha.** 아직 독립적인 보안 검토를 받지 않았습니다. 중요한 계정에 쓰기 전에 [SECURITY.md](SECURITY.md)를 읽어 보세요.

## 빠른 시작

Node 20 이상과 기본 백엔드인 Bitwarden CLI(`bw`)가 필요합니다.

```bash
export BW_SESSION="$(bw unlock --raw)"     # 보관함 잠금 해제(환경 변수에만)
npx -y blindfill session start             # 자체 헤드리스 Chromium 실행
npx blindfill fill --item <id> --url https://example.com/login --submit
```

`<id>`는 보관함 항목의 ID입니다(`npx blindfill item list`). `session start`가 Chromium을 찾을 수 없다고 하면
`npx playwright-core install chromium`을 한 번 실행하거나, `--executable <경로>`로 가지고 있는 Chromium을 지정하세요.

에이전트에서 쓰려면 MCP 서버를 실행합니다: `npx -y blindfill mcp`([설정 예시](examples/mcp-config.json)). 매일 쓴다면
`npm i -g blindfill` 후 `npx`를 빼고 실행하세요.

## 보장하는 것

- **비밀은 입력 전용.** 비밀번호, TOTP 시드, 개인 키를 반환하는 명령, MCP 도구, 라이브러리 함수는 없습니다.
- **올바른 사이트에 바인딩.** 비밀을 어디에 입력할지는 보관함 항목이 정합니다. 유사 도메인이나 교차 출처 iframe은 비밀을 읽기 전에 거부됩니다.
- **입력 후 잠금.** 이후 페이지 텍스트, DOM, 스크린샷은 거부되고 모든 출력은 제거 처리됩니다.
- **추측하지 않고 멈춤.** 모호한 필드나 알 수 없는 결과는 보고만 하고 재시도하지 않습니다.

## 지원

Bitwarden / Vaultwarden(실제 사이트에서 테스트됨, 나머지 6개 백엔드는 미검증) · Chromium, Firefox / Camoufox, Ego Lite ·
패스키 · TOTP 코드 · Android 14+ 컴패니언 앱(실험적) · macOS와 Linux(Windows는 테스트 스위트만).
구성 요소별 상태와 모든 테스트 기록: [docs/TESTED.md](docs/TESTED.md).

## 문서

| 주제                    | 문서                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| 위협 모델과 알려진 한계 | [SECURITY.md](SECURITY.md)                                                                            |
| 지원 상태와 테스트 기록 | [docs/TESTED.md](docs/TESTED.md)                                                                      |
| 내 브라우저에 연결하기  | [docs/browsers.md](docs/browsers.md)                                                                  |
| 비밀번호 관리자 설정    | [Bitwarden](docs/backends/bitwarden.md), [기타](docs/backends/other.md)                               |
| Android 컴패니언 앱     | [android/README.md](android/README.md)                                                                |
| 다른 방식과 비교        | [docs/COMPARISON.md](docs/COMPARISON.md)                                                              |
| 아키텍처, 릴리스, 기여  | [ARCHITECTURE](docs/ARCHITECTURE.md), [RELEASING](docs/RELEASING.md), [CONTRIBUTING](CONTRIBUTING.md) |

문서는 영어로 작성되어 있습니다.

## 개발

`npm ci && npm run lint && npm test && npm run build`, 그다음 `node dist/cli.js …`. MIT 라이선스.

## 번역

번역 PR을 환영합니다. 기존 [繁體中文](README.zh-TW.md), [简体中文](README.zh-CN.md), [日本語](README.ja.md), [한국어](README.ko.md)의 개선이나 새로운 언어 추가 모두 좋습니다. 내용이 다를 경우 영어 README를 기준으로 합니다.
