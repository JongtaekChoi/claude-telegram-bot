# Changelog

## [0.4.6] - 2026-07-24
### Added
- **봇이 이미지를 텔레그램으로 전송.** 에이전트가 답변 끝에 `[[ctb-image: 파일명 | 캡션]]` 마커를 붙이면
  bot.mjs가 마커를 떼고 그 파일을 사진으로 보낸다. 파일은 `projectDir/.ctb-outbox/`에서만 읽는다 —
  마커의 값에서 basename만 취해 경로 탈출을 원천 차단하고, 실제 그 폴더 안의 파일이며 허용 확장자
  (`png/jpg/jpeg/gif/webp`)·10MB 이하여야 하며, 폴더 밖을 가리키는 심볼릭 링크도 거부한다. 아웃박스를
  `projectDir` 아래 둔 건 Claude와 Codex(`workspace-write` 샌드박스) 둘 다 쓰기 가능한 위치라서다.
  전송법은 시스템 프롬프트로 provider에 자동 안내되며, `"sendImages": false`로 끌 수 있다. 나가는
  경로는 텍스트 전용이던 것을 Node 18+ 내장 `FormData`/`Blob` 기반 `sendPhoto`로 확장했다(의존성 0 유지).
### Fixed
- **provider 우선순위 문서가 실제 동작과 달랐던 문제.** 0.4.1에서 `ctb.mjs`가 `/provider` override
  (`state.provider`)를 읽도록 바뀌었는데 문서는 갱신되지 않아, README(영/국문)는 "로컬 `ctb`는 계속
  `config.provider`를 쓴다"고, `ctb --help`는 `--provider flag → config.provider → claude`라고
  안내하고 있었다. 실제 우선순위인 `--provider` 옵션 → state override → `config.provider` → `claude`로
  네 곳 모두 수정했다. 동작 변경은 없다(help 출력 문구만 바뀜).

## [0.4.5] - 2026-07-20
### Fixed
- **로컬 `ctb`가 텔레그램 세션을 이어받지 못하던 버그(0.4.3 회귀).** 0.4.3에서 세션을 방별로 옮기며
  `state.sessionId` → `state.sessions[chatId].sessionId` 구조가 됐고 마이그레이션이 최상위 키를
  지우는데, `ctb.mjs`는 그대로 최상위에서 읽고 있었다. 결과적으로 세션 ID가 항상 `undefined`라
  `--resume` 없이 매번 새 세션으로 떴다 — Claude·Codex 둘 다 해당. 이제 방별 구조를 읽고,
  0.4.3 이전 state를 위해 최상위 키 폴백도 유지한다.
### Added
- **`ctb --chat <id>`** — 이어받을 방을 지정한다. 지정하지 않으면 `allowedChatId`의 첫 번째 방
  (보통 소유자 DM)을 쓴다 — bot.mjs의 구버전 마이그레이션이 주 방을 고르는 규칙과 같다.
  DM 말고 그룹 세션을 로컬에서 이어받을 때 쓴다.

## [0.4.4] - 2026-07-20
### Fixed
- **그룹에서 `/명령@봇이름`이 명령어로 인식되지 않던 버그.** 그룹 채팅에서 텔레그램 자동완성으로
  명령어를 고르면 `/provider`가 아니라 `/provider@MyBot` 형태로 전송되는데, 명령어 파싱이 정확 매칭
  (`text === "/provider"`)이라 어디에도 걸리지 않고 일반 프롬프트로 에이전트에 넘어갔다 — 명령이 실행되는
  대신 LLM이 그 문장에 대해 아무 말이나 지어냈다. `/provider`뿐 아니라 모든 명령어가 같은 문제를 겪었음.
  이제 `handle()` 진입부에서 첫 토큰의 `@봇이름`만 벗겨낸다. 시작 시 `getMe`로 자기 username을 받아
  대소문자 무시 비교하므로, 같은 그룹에 있는 다른 봇을 향한 `/명령@다른봇`은 건드리지 않는다.

## [0.4.3] - 2026-07-16
### Added
- **방별 세션 분리** — DM과 각 그룹이 서로 독립된 Claude·Codex 세션을 가진다
  (`state.sessionId` → `state.sessions[chatId]`). 한 config에 서로 무관한 방을 여러 개 등록해도
  한 방의 대화가 다른 방 맥락으로 넘어가지 않는다. 접근은 `chatBucket`/`getSid`/`setSid` 접근자로
  일원화했고, 구버전 state의 전역 `sessionId`는 첫 실행 때 주 방(`allowedIds[0]`)으로 자동
  이관된다. 그룹 안에서는 참여자 전원이 그 그룹의 단일 세션을 공유한다(사람별 분리는 범위 밖).
- **방별 동시 실행** — 방끼리 병렬로 처리한다. DM에서 긴 작업이 돌아도 그룹은 기다리지 않는다.
  실행 상태(`busy`/`child`/`typing`/`prevSession`/`stopping`/`queue`)를 전역 변수에서 방별
  `chatRuntime` 맵으로 분리했다. 한 방 안에서는 기존대로 직렬 처리 + 큐 병합이고, 병합은 항상 한 방
  안에서만 일어나므로 세션이 섞이지 않는다. 예약 작업은 전용 슬롯(`__cron__`)에서 돌아 예약끼리는
  직렬, 사용자 방과는 병렬이다. 레이트리밋(계정 단위)과 로컬 `ctb` 락(머신 단위)은 성격상 전역으로
  유지했다.
- **`/restart` 중단 알림** — 재시작은 프로세스를 통째로 내리므로 방별 격리와 무관하게 다른 방 작업까지
  같이 죽는다. 실행 중이거나 큐가 쌓인 방에 중단 사실을 알린다(놀고 있는 방은 소음이라 제외).
### Changed
- `/stop`이 **그 방의** 프로세스와 큐만 중단한다 — 다른 방의 작업은 영향받지 않는다.
- `/reserve` 상태 표시가 모든 방의 대기 메시지를 합산해 보여준다.

## [0.4.2] - 2026-07-14
### Added
- 그룹 채팅에서 메시지를 보낸 사람을 `[From: 이름 (@username)]` 형태로 프롬프트에 표시한다(1:1 채팅은
  한 명뿐이라 표시하지 않음). `busy` 중 쌓인 메시지를 한 번에 합쳐 보내는 큐 병합 시에도 줄마다 발신자를
  구분해 표기한다 — 이전엔 마지막 발신자만 남아 앞서 온 메시지들의 발신자 정보가 유실됐었다.
### Fixed
- `ctb`가 provider를 고를 때 `state.json`의 `provider`(텔레그램 `/provider`로 전환한 값)를 무시하고
  `config.provider`만 보던 버그. 텔레그램에서 `/provider codex`로 전환해둔 상태에서 `ctb`를 실행하면
  엉뚱하게 Claude 세션을 resume해 로컬 대화가 텔레그램 쪽 세션과 분리되던 문제였음 — 우선순위를
  `--provider` → `state.provider` → `config.provider` → `claude`로 수정해 bot.mjs의 `currentProvider()`와
  동일하게 맞췄다.
- `ctb` 세션 종료 알림(`notifyTelegram`)이 `allowedChatId`가 배열일 때 `chat_id`에 배열을 그대로 넣어
  텔레그램 API가 `400 Bad Request`로 거부하던 버그 — 각 chat_id를 순회하며 개별 전송하도록 수정.
- 레이트리밋으로 메시지가 reserve 큐에 쌓인 상태에서 `/provider`로 다른 provider로 전환해도 큐가 그대로
  묶여 있던 버그 — 전환 시 예약을 즉시 풀고 새 provider로 큐를 이어서 처리하도록 수정.

## [0.4.1] - 2026-07-10
### Changed
- `ctb`의 provider 결정 우선순위(`--provider` → `config.provider` → `claude`)를 도움말에 명시했다.
- `/model` 상태·설정 안내를 provider별로 분리했다. Claude에서는 모델 별칭을 제안하고, Codex에서는
  Claude 별칭을 노출하지 않고 전체 Codex 모델 ID와 `codexModel`/CLI 기본값 사용법을 안내한다.

## [0.4.0] - 2026-07-10
### Added
- `config.json`의 `provider`로 Claude 또는 Codex를 텔레그램 봇의 메인 실행자로 선택할 수 있다.
- `ctb <config> --provider codex`가 `state.codexSessionId`를 읽어 대화형 `codex resume` 세션을 실행한다.
- `/provider`로 현재 Telegram provider를 확인하고 `/provider claude`, `/provider codex`로 state override를
  저장하거나 `/provider default`로 config 기본값을 복원할 수 있다. config 파일은 수정하지 않으며,
  Claude와 Codex의 세션·모델 override는 각각 보존된다.
- README에 마지막으로 함께 검증한 Claude Code, Codex CLI, Ollama 버전과 호환성 확인 절차를 기록했다.
- `/status`에서 봇 호스트에 실제 설치된 세 CLI 버전을 함께 표시한다.
- 기존 Codex 폴백 재설계 — Claude 레이트 리밋·크레딧 부족 시 `"codexFallback": true`이면 reserve 큐로 넘기기 전에
  `codex exec`를 실행한다. Codex 세션은 `state.codexSessionId`에 별도로 저장하고 이후
  `codex exec resume <세션ID>`로 이어간다.
- Claude와 Codex 세션은 서로 호환되지 않으므로, 성공한 Codex 폴백 내용을
  `.claude-bot/codex-handoff.md`에 누적하고 이후 Claude 호출의 시스템 프롬프트에 최근 handoff를 주입한다.
### Changed
- minor 버전을 `0.4.0`으로 올렸다.
- 한도 초과 처리 순서 변경: Codex 폴백 성공 시 `/reserve` 자동 재시도를 예약하지 않고, Codex가 꺼져 있거나
  실패했을 때만 기존 Ollama 폴백/ reserve 흐름으로 내려간다.
- 일반 메시지, 첨부 파일, 예약 작업과 cron 자연어 해석이 선택된 provider를 사용한다. `/plan`, `/compact`,
  자동 compact는 Claude provider에서만 동작한다.
- `/status`가 활성 provider에 맞는 모델·세션·fallback 상태를 표시하고 세 CLI 버전을 함께 확인한다.
- Codex fallback 응답 머리말을 짧은 `Codex fallback`/`Codex 폴백` 표시로 줄였다.
- 로컬 lock 안내에서 특정 provider를 뜻하는 `ctb claude` 표현을 중립적인 `ctb`로 변경했다.
- 기본 설정 예시의 Claude 권한을 `bypassPermissions`에서 `acceptEdits`로 낮췄다.

## [0.3.41] - 2026-07-09
### Changed
- Ollama 폴백이 이제 **대화 맥락을 이어받는다** — 기존에는 `localhost:11434/api/chat` HTTP API를
  직접 호출해 직전 프롬프트 1개만 단발로 처리했고, 헤더에도 "세션은 이어지지 않아요"라고 안내했음.
  이제 `ollama launch claude --model <m> --yes -- … --resume <세션ID>` 로 **Claude Code CLI 자체를
  로컬 모델로 구동**해, 폴백·`/ollama` 모드 응답이 Claude와 나누던 대화 스레드를 이어감
  - 반환된 `session_id`를 `state.sessionId`에 저장해 다음 턴까지 체이닝
  - 기본 모델 `phi3:mini` → `qwen3.5:4b` (실제 세션 resume 테스트로 검증된 모델)
  - config 옵션 추가: `ollamaBin`(실행 파일 경로), `ollamaTimeout`(응답 대기 ms, 기본 360000 —
    로컬 4B 모델 콜드스타트가 첫 응답까지 수 분 걸릴 수 있어 넉넉히 설정)
  - ⚠️ 완전한 세션 승계가 아니라 **최선 노력(best-effort)**임을 문서에 명시. 로컬 모델의 런타임
    컨텍스트 창(`num_ctx`)은 Ollama 기본값이 ~4K라 긴 Claude 세션(관측상 ~15K)은 잘려 들어감.
    `Modelfile`로 `num_ctx`를 키운 변형 모델을 만들어 `ollamaModel`로 지정하면 완화되지만, KV 캐시가
    RAM을 잡아먹으므로 크기는 머신에 맞춰야 함 — 8GB 머신에선 ~6K가 안전 상한(32K는 스왑으로 먹통).
    README(영/국문)의 `ollamaModel` 항목과 Ollama 폴백 설명에 관련 안내·한계 추가
  - 폴백 포지셔닝 정직화: 작은 로컬 모델은 코딩·도구 호출을 Claude처럼 못 하므로
    "완전한 코딩 대체재"가 아니라 **경량 텍스트 조수**로 명시. 잘하는 역할(Claude 복귀 후
    시킬 요청을 미리 정리·초안 작성, 요약, 메모 정리)을 안내로 추가
### Fixed
- launchd로 뜬 봇에서 Ollama 폴백이 `spawn ollama ENOENT`로 실패하던 문제 — launchd 데몬은
  로그인 셸을 거치지 않아 `.zshrc`/`brew shellenv`가 설정한 PATH(`/opt/homebrew/bin` 등)를
  상속받지 못함(`claudeBin`과 동일 원인). `ollamaBin` 미지정 시 흔한 Homebrew/시스템 설치
  경로를 자동으로 탐색하도록 수정

## [0.3.40] - 2026-07-06
### Fixed
- `/status`가 npm에 아직 배포되지 않은 로컬 버전을 npm 레지스트리의 구버전과 비교해
  실제로는 최신인데도 "업데이트 있음"처럼 `버전: 0.3.39 → 0.3.36 ✨`로 잘못 표시하던 버그
  - 버전 문자열이 다르기만 하면 화살표를 붙였고, 어느 쪽이 더 최신인지는 비교하지 않았음
  - 이미 있던 `isNewer()` semver 비교 함수를 사용하도록 수정 — 진짜로 더 최신 버전이 있을 때만 화살표 표시

## [0.3.39] - 2026-07-06
### Added
- `/autocompact` 명령어 — 자동 컴팩션 토큰 임계값(`autoCompactThreshold`)을 런타임에 확인·변경
  - `/autocompact` — 현재 임계값 확인
  - `/autocompact <숫자>` — 임계값 변경 (state에 저장, 재시작 후에도 유지)
  - `/autocompact off` — 자동 컴팩션 비활성화 (`0`으로 설정)
  - `/autocompact default` — config.json의 값(또는 기본값 100000)으로 초기화
  - 기존에는 config.json을 직접 수정하고 봇을 재시작해야만 값을 바꿀 수 있었음

## [0.3.38] - 2026-07-04
### Fixed
- 봇이 busy 상태일 때 사진(첨부)이 포함된 메시지가 연달아 들어오면, 대기열을 합치는 과정에서
  마지막 메시지를 제외한 앞선 메시지들의 사진이 통째로 사라지던 버그
  - `drainQueue()`가 텍스트/캡션만 번호 붙여 병합하고 `{...group[group.length-1].msg, ...}`로
    마지막 메시지 필드만 남겨, 먼저 온 사진의 `photo`/`_mediaGroup`이 유실됨
  - 큐에 쌓인 모든 메시지의 첨부(사진/문서/음성/영상)를 순서대로 모아 `_mediaGroup`으로
    합치도록 수정 — Claude가 먼저 온 사진도 모두 확인 가능

## [0.3.37] - 2026-07-04
### Fixed
- `busy` 플래그 교착(deadlock) 버그 — `/cron add`, `/plan` 승인 실행, 일반 메시지 처리 3곳에서
  `busy = true` 직후의 `await tg("sendChatAction", ...)` 호출이 `try/catch` 밖에 있어,
  일시적 네트워크 오류로 이 호출이 실패하면 `busy`가 영영 `true`로 남아버리는 문제
  - `/stop`은 `currentChild`가 없어 "실행 중인 작업 없음"이라 답하지만, 새 메시지는 전부
    무한 대기열에만 쌓이는 모순된 멈춤 상태가 발생
  - `sendChatAction` 호출을 각 `try` 블록 안으로 이동해, 실패해도 기존 `catch`/`finally`가
    `busy`/`currentTyping`을 정상적으로 초기화하도록 수정

## [0.3.36] - 2026-07-03
### Fixed
- `/plan`(0.3.35)에서 `send()`가 제너레이터 `chunks()`를 배열처럼 `.length`로 인덱싱해
  모든 메시지가 무응답으로 사라지던 버그
  - `chunks()`는 `function*`이라 `.length`가 `undefined` → 루프 조건이 항상 false로 평가되어
    본문이 한 번도 실행되지 않음 (예외도 로그도 없이 조용히 실패)
  - `const cs = chunks(text)` → `const cs = [...chunks(text)]`로 배열 변환하여 수정
  - 자세한 원인 분석: `docs/incidents/2026-07-03-plan-send-silent-failure.md`

## [0.3.35] - 2026-06-27
### Added
- `/plan <요청>` — Plan Mode
  - 봇의 `permissionMode` 설정과 무관하게 강제로 `plan`(읽기 전용) 모드로 1회 실행
  - 계획 내용과 함께 텔레그램 인라인 버튼(✅ 진행 / ❌ 취소) 전송
  - **진행** 클릭 시 같은 세션을 봇의 실제 `permissionMode`로 이어서 계획 실행
  - **취소** 클릭 시 세션 변경 없음 (애초에 plan 모드라 편집 자체가 없었음)
  - `/new`로 세션이 바뀌면 대기 중인 승인은 자동 만료
  - 헤드리스 `--print` 모드는 진짜 `ExitPlanMode` 툴 인터셉트(중간 정지)가 불가능해, plan 실행 → 승인 → resume 실행의 2단계 방식으로 구현

## [0.3.34] - 2026-06-27
### Added
- 커스텀 명령어 — `config.json`의 `commands` 필드로 프로젝트별 `/명령어` 정의
  - `run`: 쉘 명령어 실행, 출력을 텔레그램으로 전송
  - `/cmd arg1 arg2` 형태로 인자 전달 가능
  - Telegram `/` 자동완성 메뉴에 자동 등록
  - Claude 와 독립 실행 (busy 상태와 무관)
  - 60초 타임아웃, 4000자 초과 시 truncate

```json
"commands": {
  "deploy": { "run": "npm run deploy", "description": "프로젝트 배포" },
  "logs":   { "run": "tail -n 50 ./app.log", "description": "최근 로그" }
}
```

## [0.3.33] - 2026-06-27
### Fixed
- 0.3.31 에서 `-p`를 args 맨 앞에 두어 `--output-format`이 `-p`의 값으로 먹히는 버그
  - 모든 `--flag value` 옵션 뒤에 `-p -- <prompt>` 배치로 수정 (터미널 테스트 검증 순서)

## [0.3.32] - 2026-06-27
### Added
- 자동 컴팩션 — `cache_read_input_tokens` 가 임계값 초과 시 `/compact` 자동 실행
  - 기본값 100,000 토큰 (`config.json` 에 `"autoCompactThreshold": 100000` 으로 조정 가능)
  - 0 으로 설정하면 비활성화
  - 압축 후 텔레그램으로 알림 전송

## [0.3.31] - 2026-06-26
### Fixed
- `-`로 시작하는 메시지가 여전히 옵션으로 오해되던 문제 (0.3.28~0.3.30 미해결)
  - `-p<prompt>` 인라인 묶기는 claude CLI 파서가 미지원 (`-p` + `-prompt` 로 분리)
  - 프롬프트를 모든 옵션 뒤 `--` 구분자 다음에 위치 인자로 전달하도록 변경

## [0.3.30] - 2026-06-26
### Fixed
- `-p <prompt>` → `-p<prompt>` (붙여쓰기) 방식으로 변경 (실패 — 0.3.31에서 재수정)

## [0.3.29] - 2026-06-26
### Fixed
- 구버전 `claude` CLI에서 `--print` 미지원으로 발생하는 "unknown option" 에러
  - 시작 시 `claude --help` 로 지원 여부 탐지 → 구버전이면 `-p <prompt>` 자동 폴백

## [0.3.28] - 2026-06-25
### Fixed
- `-`로 시작하는 메시지(예: `-9038502는 잔액이고…`)가 Claude CLI 옵션으로 오해되는 문제
  - `-p <prompt>` → `--print=<prompt>` 방식으로 변경

## [0.3.26] - 2026-06-24
### Fixed
- `"session limit"` 에러 미감지 문제 — `isFallbackError` / `classifyClaudeError` 에 추가
- `"resets 7:20pm"` 형식 파싱 실패 — `parseResetTime` regex에서 `at` 없이도 시간 추출
### Changed
- 레이트리밋 에러 시 메시지를 큐에 보관 후 리셋 시간에 자동 재시도 (busy 큐와 동일 메커니즘)
  - 제한 중 추가로 보내는 메시지도 큐에 쌓임
  - `/reserve` → 대기 현황 보기, `/reserve rm` → 큐 전체 취소

## [0.3.25] - 2026-06-23
### Added
- `/ollama` 명령어 — Ollama 채팅 모드 수동 토글
  - 켜는 동안 메시지는 Claude 없이 Ollama로 직접 처리 (Claude 세션은 유지)
  - 다시 `/ollama` 로 끄면 Claude 모드로 복귀
### Changed
- Ollama 요청을 `/api/generate` → `/api/chat` 으로 전환
  - 시스템 프롬프트 지원: `cfg.persona` + 간결체 instruction 주입
  - 응답 품질 개선 (특히 작은 모델에서 효과적)

## [0.3.24] - 2026-06-23
### Fixed
- ctb 종료 시 요약이 항상 SKIP으로 반환되는 문제 수정
  - 세션 컴팩션 후 `---ctb:start---` 마커가 묻히는 문제 → 최근 대화 기반 요약으로 변경

## [0.3.23] - 2026-06-23
### Added
- 텔레그램 메시지 메타데이터 프롬프트 주입
  - 포워드 메시지: 출처(유저/채널/숨김) 자동 감지 → `[Forwarded from: ...]` 표기
  - 리플라이: 원본 메시지 내용(최대 300자) → `[Replying to ...: "..."]` 표기

## [0.3.22] - 2026-06-23
### Changed
- Codex 폴백 → Ollama 폴백으로 교체 (fetch 기반, 의존성 0 유지)
  - config.json에 `"ollamaFallback": true`, `"ollamaModel": "phi3:mini"` 로 설정
  - Claude 레이트리밋·크레딧 부족 시 로컬 Ollama 모델로 자동 대체

## [0.3.21] - 2026-06-23
### Added
- `/testfallback` 명령어 — Codex 폴백 연결을 직접 테스트

## [0.3.20] - 2026-06-23
### Added
- Codex 폴백 — Claude 레이트리밋·크레딧 부족 시 OpenAI Codex로 자동 대체 응답
  - config.json에 `"codexFallback": true` 로 활성화, `codex` CLI가 설치된 경우에만 동작
  - 응답 앞에 "🌙 Claude가 잠시 쉬고 있어요" 안내 문구 자동 삽입

## [0.3.19] - 2026-06-19
### Added
- `/compact` 명령어 — 세션을 유지한 채 컨텍스트를 요약 압축 (`/new` 없이 공간 확보)
- "Prompt is too long" 에러 감지 → `/compact` 또는 `/new` 안내 메시지로 대체

## [0.3.18] - 2026-06-19
### Fixed
- 같은 이미지를 여러 번 보내면 파일이 덮어써지는 버그 — 파일명에 타임스탬프 추가 (`tg-<ts>-<id>.<ext>`)

## [0.3.17] - 2026-06-18
### Fixed
- `/remember` 메모리가 persona에 덮어쓰여 무시되는 문제 — 메모리를 시스템 프롬프트 맨 앞에 배치하고 헤더를 `## RULES (must follow before anything else)` 로 강화

## [0.3.16] - 2026-06-18
### Changed
- `allowedChatId` 를 배열로도 지정 가능 — `["chatId1", "chatId2"]` 형태로 여러 사용자 허용 (기존 문자열 형태 하위 호환)
- cron 결과·업데이트 알림을 모든 허용 채팅에 브로드캐스트

## [0.3.15] - 2026-06-17
### Added
- `/reserve` 명령어 — 사용 한도 초과 시 리셋 시점에 재시도 예약, `/reserve <다른 메시지>` 로 내용 변경, `/reserve rm` 으로 취소

## [0.3.14] - 2026-06-17
### Added
- 여러 이미지 동시 전송 지원 — `media_group_id` 감지 후 1초 대기, 그룹 내 모든 이미지를 한 번에 Claude에 전달

## [0.3.13] - 2026-06-16
### Added
- `ctb` 세션 시작 시 `---ctb:start---` 마커 삽입 — 종료 요약이 텔레그램 이전 대화를 제외하고 터미널 세션 작업만 요약

## [0.3.12] - 2026-06-16
### Fixed
- `ctb` 종료 알림 fetch 실패 — `dns.setDefaultResultOrder("ipv4first")` 추가로 IPv6 우선 시도 문제 해결
- `ctb` 알림 언어 — `cfg.lang` 미설정 시 `$LANG` 환경변수로 폴백
- `ctb` 알림 메시지에 `[터미널]` / `[local]` 레이블 추가로 텔레그램 채팅 응답과 구분

## [0.3.11] - 2026-06-15
### Fixed
- `ctb` 종료 요약을 config `lang` 에 맞는 언어로 전송 (ko 설정 시 한국어)

## [0.3.10] - 2026-06-15
### Fixed
- `ctb` Ctrl+C 종료 시에도 텔레그램 요약 알림 전송
- 세션 종료 요약을 10단어 이내 짧은 구문으로 제한

## [0.3.9] - 2026-06-15
### Added
- 업데이트 자동 감지 — 시작 시 24h 주기로 npm 최신 버전 확인, 새 버전이 있으면 버전당 1회 텔레그램 알림

## [0.3.8] - 2026-06-15
### Added
- `ctb` 세션 종료 시 텔레그램으로 한 줄 요약 자동 전송 — config 에 `"ctbNotify": false` 로 비활성화 가능

## [0.3.7] - 2026-06-15
### Fixed
- Claude 에러 분류를 JSON 경로(`is_error: true`)에도 적용 — 0.3.6 에서 비정상 종료만 처리하던 것을 JSON 응답 에러까지 확장

## [0.3.6] - 2026-06-14
### Fixed
- Claude 에러 메시지 분류 — 크레딧 부족·레이트리밋·서버 과부하·컨텍스트 초과를 감지해 날 것 에러 대신 안내 메시지 표시

## [0.3.5] - 2026-06-14
### Added
- `/status` 에 npm 최신 버전 표시 — 업데이트가 있으면 `0.3.4 → 0.3.5 ✨` 형식으로 알림

## [0.3.4] - 2026-06-14
### Fixed
- `/stop` 이 작업 중에 무시되는 버그 수정 — 폴링 루프의 `await handle()` 로 인해 `/stop` 메시지가 현재 작업 완료까지 처리되지 않던 문제

## [0.3.3] - 2026-06-13
### Fixed
- `ctb` 전역 설치 시 세션 연결 안 되는 문제 — config 탐색 순서를 `cwd` 우선으로 변경

## [0.3.2] - 2026-06-13
### Fixed
- 한국어 `/help` 텍스트에서 `/cron` 줄 중복 제거

## [0.3.1] - 2026-06-13
### Added
- 퍼시스턴트 메모리 — `/remember <내용>` 으로 저장, `/new` 후에도 유지, 매 대화에 자동 주입
- `/memory` — 메모리 확인 · `/memory clear` 로 삭제
- `init` 기본 파일명을 `mybot.json` 으로 변경

## [0.3.0] - 2026-06-12
### Added
- `/stop` — 진행 중인 작업 중단 · `--reset` 옵션으로 세션 롤백
- 메시지 큐 — busy 중 수신된 메시지를 대기 후 자동 처리, 여러 개면 시간 정보와 함께 일괄 병합
- `init` 파일명 직접 지정 가능 (`ctb init mybot.json`)

## [0.2.7] - 2026-06-11
### Added
- `fable` 모델을 MODEL_SUGGESTIONS 및 모델 권유 프롬프트에 추가

## [0.2.6] - 2026-06-11
### Added
- 현재 모델을 시스템 프롬프트에 주입 — Claude가 질문 난이도에 따라 상위 모델 전환 스스로 권유

## [0.2.5] - 2026-06-10
### Added
- `/model` — 런타임 모델 보기·전환 (`/model sonnet`, `/model default` 등)

## [0.2.4] - 2026-06-09
### Changed
- 데이터(state·attachments)를 `.claude-bot/` 숨김 폴더로 이동, 기존 데이터 자동 이주

## [0.2.3] - 2026-06-08
### Added
- `/status` — 봇 이름·버전·모델·세션·예약 작업·프로젝트 경로 표시

## [0.2.1] - 2026-06-07
### Added
- i18n — 영어 기본 + 한국어, `from.language_code` 로 사용자별 자동 판별
- `/` 명령 자동완성 메뉴 등록 (`setMyCommands`)
- 한 줄 인라인 코드를 `<pre>` 블록으로 렌더링 (텔레그램 복사 버튼)

## [0.2.0] - 2026-06-06
### Added
- `ctb` CLI — 로컬 터미널에서 텔레그램 봇 세션 공유
- `/cron` — 예약 작업 자연어 추가·삭제·목록
- `/restart` — 문법 검사 후 안전 재시작
- 조용한 예약 작업 — 출력이 비었거나 `SKIP` 이면 전송 안 함

## [0.1.0] - 2026-06-01
### Added
- 최초 릴리스 — Telegram → `claude -p` 헤드리스 브리지, zero-dependency, 단일 파일
- 파일 첨부 지원, HTML 포맷팅, IPv4 우선 설정
- `launchd` 데몬 예시 (`com.claudebot.example.plist`)
