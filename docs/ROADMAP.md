# Roadmap

구현 예정 기능 정리. 현재 코드(`bot.mjs`, v0.2.2) 기준으로 작성.

---

## 1. `/status` — 봇 상태/버전 명령

채팅에서 봇의 버전·설정·세션 상태를 한눈에 확인.

**보여줄 내용**
- 봇 버전 (`package.json` 의 `version` — 이미 `--version` 에서 읽는 로직 있음, `bot.mjs:48`)
- 봇 이름 (`cfg.name`)
- 현재 모델 (`cfg.model` 또는 기본값)
- 현재 세션 ID 유무 / `/new` 이후 경과 (`state.sessionId`, `bot.mjs:240`)
- 예약 작업 개수 (`schedule.length` / `state.cron`)
- 프로젝트 디렉터리 (`cfg.projectDir`)
- 권한 모드 (`cfg.permissionMode`)

**구현 메모**
- `bot.mjs:721` 부근 명령 분기(`/start`, `/id`, `/cron` …)에 `/status` 추가.
- i18n 키 추가 (en/ko 둘 다, `bot.mjs:88~` 의 `t()` 패턴).
- `setMyCommands` 목록(`bot.mjs:201`)에도 등록.
- 버전 문자열은 시작 시 한 번 읽어 캐시 (매 호출마다 `readFileSync` 피하기).

---

## 2. 모델 선택 기능

지금은 `cfg.model` 로 정적 고정 (`bot.mjs:358`, `if (cfg.model) args.push("--model", ...)`).
런타임에 채팅에서 모델을 바꿀 수 있게.

**방향**
- `/model` — 인자 없으면 현재 모델 + 선택지 표시, 인자 있으면 전환
  - 예: `/model opus`, `/model sonnet`, `/model claude-haiku-4-5`
  - 별칭(opus/sonnet/haiku) → 풀 모델 ID 매핑 테이블.
- 선택값을 `state` 에 저장(`state.model`)해서 재시작 후에도 유지.
  `runClaude` 의 모델 결정 우선순위: `state.model` > `cfg.model` > 기본값.
- 허용 모델 화이트리스트를 `cfg` 에 둘지 검토(아무 문자열이나 `--model` 로 넘기면 오류날 수 있음).

**구현 메모**
- `runClaude` (`bot.mjs:341`) 의 model 인자 부분을 `state.model ?? cfg.model` 로.
- `/model` 명령 분기 + i18n + `setMyCommands` 등록.
- 인라인 키보드(Telegram reply markup)로 버튼 선택 UX 고려 — 현재 인라인 키보드 사용처 없으니 도입 비용 있음. 1차는 텍스트 인자로 충분.

---

## 3. 데이터 저장 위치를 숨김 폴더로

현재 `state.json` / `attachments/` 가 config 파일과 **같은 폴더(`DATA_DIR`)** 바로 아래에 흩어짐
(`bot.mjs:67` `DATA_DIR = dirname(CONFIG_PATH)`, `:71` STATE_PATH, `:690` attachments).

프로젝트 루트가 지저분해지므로 기본 저장 위치를 루트 아래 **숨김 폴더**(예: `.claude-bot/`)로.

**제안 구조**
```
<DATA_DIR>/
  config.json
  .claude-bot/
    state.json          (또는 <configname>.state.json)
    attachments/
    bot.log / bot.error.log
```

**고려사항**
- **하위 호환**: 기존 사용자는 루트에 `state.json` 이 이미 있음.
  - 시작 시 숨김 폴더에 state 가 없고 루트에 있으면 → 마이그레이션(이동) 또는 루트 우선 읽기.
- 폴더 없으면 생성 (`mkdirSync(..., { recursive: true })` — 이미 `mkdirSync` import 됨, `bot.mjs:17`).
- `.gitignore` 갱신: 현재 `state.json`, `attachments/` 등 개별 항목(`/.gitignore`) → `.claude-bot/` 한 줄로 단순화 가능.
- 폴더명을 `cfg.dataDir` 로 오버라이드 가능하게 할지 검토.
- multi-persona 셋업(여러 config) 에서 state 파일명이 config 이름 파생(`bot.mjs:70`)인 점 유지.

**구현 메모**
- `STATE_PATH`, attachments `dir`(`bot.mjs:690`), 로그 경로를 한 곳(`DATA_DIR` 계산 직후)에서 파생하도록 정리.
- 배포 환경(`com.claudebot.dev`, source 에서 `bot.mjs` 실행)에서 경로 바뀌므로 `/restart` 후 동작 확인 필요.

---

## 우선순위 / 순서 제안

1. **`/status`** — 가장 작고 독립적, 다른 작업의 디버깅에도 유용.
2. **데이터 저장 위치(숨김 폴더)** — 경로 리팩터링이라 다른 기능 들어오기 전에 하는 게 충돌 적음.
3. **모델 선택** — `state` 저장 의존하므로 2 이후가 깔끔.
