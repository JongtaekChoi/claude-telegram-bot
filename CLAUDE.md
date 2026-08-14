# Claude Code Instructions

## 작업 범위
`bot.mjs`(단일 파일, 의존성 0)와 `ctb.mjs`, `README`(영/국문)를 주로 다룬다.
변경 시 기존 코드 스타일을 따르고, `config.json` / `state.json` 같은 민감 파일은 건드리지 않는다.

## 명령어를 바꿨으면 안내 문구도 같이 바꾼다
문법(인자·옵션)을 손댔으면 그 명령을 설명하는 자리를 **전부** 찾아 고친다. 한 군데만 고치면
사용자는 옛 문법을 보고 새 기능이 있는 줄 모른다. 실제로 `/memory rm` 에 범위를 붙였을 때
여섯 군데가 갈렸다. 찾을 자리:

- `<명령>Show` / `<명령>List` — **목록 아래 붙는 안내. 가장 많이 읽히는 자리이고 가장 잘 빠뜨린다.**
- `<명령>Usage` — 잘못 입력했을 때
- `helpText` — 영/한 각각 (한 파일에 두 벌 있다)
- `setMyCommands` 배열 — 텔레그램 `/` 자동완성 설명. 영/한 각각
- 그 밖의 유도 문구 (`memoryCrowded` 처럼 다른 명령을 권하는 문장)
- `README.md` · `README.ko.md` 명령어 표

`grep -n "<명령>" bot.mjs` 로 훑고, 문구가 영·한 쌍으로 있는지 확인한다 — 한쪽만 고치는 게 흔한 실수다.

## 배포 규칙
`git push` 또는 `npm publish` 전에 반드시 사용자에게 먼저 확인한다.
버전 번호 변경(package.json)과 CHANGELOG 업데이트는 커밋 전에 같이 처리한다.

**`npm publish` 전에는 실제 봇으로 코드 테스트가 필수다.** `node --check`(문법 검사)만으로는 부족하다 —
실제로 텔레그램 메시지를 보내서 응답이 오는지 확인한다. 특히 `send()`, 메시지 큐, 인라인 버튼처럼
텔레그램 왕복이 있는 코드를 건드렸다면 반드시 실동작 확인 후 배포할 것.
(계기: [docs/incidents/2026-07-03-plan-send-silent-failure.md](docs/incidents/2026-07-03-plan-send-silent-failure.md) —
제너레이터 함수를 배열처럼 인덱싱해 `send()`가 통째로 무응답이 됐는데, 실사용 테스트 없이 배포되어 발견이 늦어짐.)
