# Changelog

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
