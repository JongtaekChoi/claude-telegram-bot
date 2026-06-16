# Claude Code Instructions

## 작업 범위
`bot.mjs`(단일 파일, 의존성 0)와 `ctb.mjs`, `README`(영/국문)를 주로 다룬다.
변경 시 기존 코드 스타일을 따르고, `config.json` / `state.json` 같은 민감 파일은 건드리지 않는다.

## 배포 규칙
`git push` 또는 `npm publish` 전에 반드시 사용자에게 먼저 확인한다.
버전 번호 변경(package.json)과 CHANGELOG 업데이트는 커밋 전에 같이 처리한다.
