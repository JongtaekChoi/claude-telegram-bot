# Roadmap

v0.3.8 기준 미구현 아이디어. 우선순위 순.

---

## 1. 누적 비용 추적 (`/cost`)

`runClaude` 가 이미 `res.cost` (USD) 를 반환함. `state.json` 에 누적하면 됨.

- `/cost` — 오늘 / 이번 달 / 누적 비용 표시
- `/status` 에 오늘 비용 한 줄 추가도 가능

zero-dep 유지, state 스키마 변경만 필요.

---

## 2. Claude 생성 파일 텔레그램 전송

Claude 가 파일을 만들었을 때 (`projectDir` 내 신규 파일) 텔레그램으로 전송.

- 응답 텍스트에서 파일 경로 패턴 감지 → `sendDocument` API 호출
- 이미지면 `sendPhoto` 로 미리보기

사용자가 명시적으로 요청한 경우에만 전송하는 opt-in 방식이 안전.

---

## 3. `allowedChatId` 배열 지원

현재 단일 chatId 만 허용. 배열로 확장하면 팀 사용 가능.

```json
"allowedChatId": [123456, 789012]
```

각 사용자별 세션 분리 여부 검토 필요.

---

## 4. 봇 간 공유 문서 (블랙보드 패턴)

여러 페르소나 봇이 `.claude-bot/shared.md` 를 읽고 씀.
코드 변경 없이 persona 프롬프트 컨벤션만으로 구현 가능.

- 각 봇의 `persona` 에 "작업 시작·완료 시 shared.md 확인·기록" 지침 추가
- 페르소나 간 협업 맥락 공유

---

## 5. 웹훅 모드

현재 롱폴링(30s timeout) 방식. 웹훅으로 전환하면 응답 레이턴시 개선.

- `cfg.webhookUrl` 설정 시 웹훅 모드로 전환
- Node `http` 모듈로 수신 (zero-dep 유지 가능)
- 로컬 개발엔 폴링이 더 편하므로 설정으로 선택
