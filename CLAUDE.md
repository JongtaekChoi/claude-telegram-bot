# Claude Code Instructions

## 작업 범위
`bot.mjs`(단일 파일, 의존성 0)와 `ctb.mjs`, `README`(영/국문)를 주로 다룬다.
변경 시 기존 코드 스타일을 따르고, `config.json` / `state.json` 같은 민감 파일은 건드리지 않는다.

## 배포 규칙
`git push` 또는 `npm publish` 전에 반드시 사용자에게 먼저 확인한다.
버전 번호 변경(package.json)과 CHANGELOG 업데이트는 커밋 전에 같이 처리한다.

**`npm publish` 전에는 실제 봇으로 코드 테스트가 필수다.** `node --check`(문법 검사)만으로는 부족하다 —
실제로 텔레그램 메시지를 보내서 응답이 오는지 확인한다. 특히 `send()`, 메시지 큐, 인라인 버튼처럼
텔레그램 왕복이 있는 코드를 건드렸다면 반드시 실동작 확인 후 배포할 것.
(계기: [docs/incidents/2026-07-03-plan-send-silent-failure.md](docs/incidents/2026-07-03-plan-send-silent-failure.md) —
제너레이터 함수를 배열처럼 인덱싱해 `send()`가 통째로 무응답이 됐는데, 실사용 테스트 없이 배포되어 발견이 늦어짐.)
