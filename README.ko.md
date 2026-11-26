<div align="center">

# blindfill

**AI 에이전트가 비밀번호를 보지 않고도 웹사이트에 로그인하게 합니다.**

[![CI](https://github.com/mics8128/blindfill/actions/workflows/ci.yml/badge.svg)](https://github.com/mics8128/blindfill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](SECURITY.md)
[![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](examples/mcp-config.json)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어**

</div>

AI 에이전트가 **비밀번호를 전혀 보지 않고도** 웹사이트에 로그인할 수 있게 합니다. blindfill은 비밀번호 관리자에서 자격 증명을 읽어 페이지의 오리진(origin)에 바인딩되어 있는지 확인한 뒤, 실제 폼에 입력하고 페이지 구조와 결과만 반환합니다. 비밀 값은 쓰기 전용(`SecretHandle.into(sink)`)이며 출력에서 제거(scrub)되고, 입력이 끝나면 세션이 잠깁니다.

> **상태: alpha (0.1.0-alpha.0).** 먼저 [SECURITY.md](SECURITY.md)에서 위협 모델과 알려진 한계를 읽어 보세요.

## 동작하는 것 (테스트 스위트로 검증됨)

- Web 액추에이터(Playwright + Chromium): 오리진 바인딩, 교차 출처 iframe 거부, 허니팟(honeypot) 필드 건너뛰기, SPA 렌더링 대기, 키 이벤트 폴백, 1회성 제출, 입력 후 잠금.
- Bitwarden `bw` 백엔드(모의 CLI와 픽스처로 검증), 그리고 **블라인드로 작성되어 검증되지 않은** 백엔드 6개(`docs/backends/` 참고).
- CLI 및 MCP 서버(stdio). 유출 테스트가 canary 비밀번호를 모든 출력과 상태 파일에서 검색합니다.

## 미완료

- Android 액추에이터(예외를 던지는 스텁). 어떤 백엔드도 실제 볼트로는 검증되지 않았습니다. 아직 배포되지 않았습니다. 패스키(passkey)는 지원하지 않습니다.

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
