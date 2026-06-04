# Claude Telegram Bot (Cube Brain Trainer 전용)

텔레그램 메시지를 받아 이 프로젝트 폴더에서 `claude -p`(헤드리스 모드)를 실행하고
결과를 다시 텔레그램으로 보내주는 작은 브릿지. 의존성 없음 (Node 18+ 내장 기능만 사용).

```
[너] → Telegram → bot.mjs → claude -p (이 프로젝트 폴더) → 결과 → Telegram
```

검증 완료: `bypassPermissions` 헤드리스 모드 정상 동작 확인. 쉘·git·테스트까지 자동 실행됨.

---

## ⚡ 빠른 시작 (내가 할 일)

**1) 봇 토큰 발급** — 텔레그램에서 `@BotFather` → `/newbot` → 이름/username 지정 → 토큰 복사

**2) 설정 파일 생성**
```sh
cd /Users/jtchoi/Projects/cube-brain-trainer/tools/claude-telegram-bot
cp config.example.json config.json
# config.json 에 BotFather 토큰만 붙여넣기 (allowedChatId 는 일단 비워둠)
# permissionMode 는 이미 bypassPermissions 로 설정돼 있음
```

**3) chatId 알아내기 + 실행**
```sh
node bot.mjs
# → 텔레그램에서 봇에게 아무 메시지나 전송 → 봇이 이 채팅의 chatId 를 답장
# → 그 숫자를 config.json 의 allowedChatId 에 넣고 봇 재시작 (Ctrl+C 후 다시 node bot.mjs)
# 이제 너만 사용 가능
```

**4) 사용** — 텔레그램으로 메시지 전송:
- `cross 솔버 테스트 돌리고 통과하면 커밋 후 push 해줘`
- `solve-2nd-floor-edges.ts 에 엣지 케이스 추가해줘`

**5) 항상 켜두기** (선택)
```sh
cp com.cube.claudebot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cube.claudebot.plist
tail -f bot.log
```

> ⚠️ 봇은 현재 작업 브랜치(`develop`) 기준으로 동작함. push 시점 등 브랜치 관리는 메시지로 명확히 지시할 것.

자세한 설명은 아래 섹션 참고.

---

## 1. 봇 만들기 (BotFather)

1. 텔레그램에서 **@BotFather** 검색 → 대화 시작
2. `/newbot` 입력 → 봇 이름과 username 지정 (username은 `_bot`으로 끝나야 함)
3. 받은 **토큰**을 복사 (예: `123456789:AAxxxxxxxx`)

## 2. 설정

```sh
cd tools/claude-telegram-bot
cp config.example.json config.json
```

`config.json` 편집:

| 키 | 설명 |
|---|---|
| `token` | BotFather에서 받은 토큰 |
| `allowedChatId` | **비워두고 시작** → 봇이 알려줌 (아래 3단계) |
| `projectDir` | 작업 폴더 (기본값 그대로 두면 됨) |
| `claudeBin` | `which claude` 결과 (절대경로 권장) |
| `permissionMode` | `acceptEdits`(파일편집 자동승인) / `bypassPermissions`(전부 자동, 쉘 포함) |
| `model` | 비워두면 기본 모델. `opus` / `sonnet` 등 |

## 3. 내 chatId 알아내기

```sh
node bot.mjs
```

실행 후 텔레그램에서 봇에게 아무 메시지나 보내면, 봇이 **이 채팅의 chatId**를 답장해줌.
그 숫자를 `config.json`의 `allowedChatId`에 넣고 봇을 재시작. → 이제 너만 쓸 수 있음.

## 4. 사용

봇에게 그냥 메시지를 보내면 됨:

- `cross 솔버 테스트 돌려보고 결과 알려줘`
- `solve-2nd-floor-edges.ts 에 엣지 케이스 추가해줘`

명령어:
- `/new` — 대화 맥락 초기화 (새 세션)
- `/id` — 채팅 ID 확인
- `/help` — 도움말

세션은 자동으로 이어짐 (`--resume`). `state.json`에 마지막 세션 ID가 저장돼서
봇을 재시작해도 맥락이 유지됨. 맥락을 끊고 싶으면 `/new`.

---

## 5. 항상 켜두기 (launchd, 맥 재부팅·크래시에도 자동 재시작)

```sh
# 경로/노드버전이 다르면 plist를 먼저 수정
cp com.cube.claudebot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cube.claudebot.plist
```

관리 명령:
```sh
launchctl list | grep claudebot          # 동작 확인
launchctl unload ~/Library/LaunchAgents/com.cube.claudebot.plist   # 중지
tail -f bot.log                          # 로그 보기
tail -f bot.error.log                    # 에러 로그
```

> 로그인 세션에서 도는 LaunchAgent라서 claude의 키체인/OAuth 인증을 그대로 사용함.
> 맥이 잠자기 모드면 폴링도 멈추니, 시스템 설정 > 배터리/전원에서 절전 해제 권장.

---

## ⚠️ 보안 주의

- **반드시 `allowedChatId`를 설정**할 것. 안 하면 봇 토큰을 아는 누구나 네 맥에서 명령 실행 가능.
- `permissionMode`:
  - `acceptEdits` — 파일 편집은 자동 승인, 그 외(쉘 등)는 제한. 비교적 안전.
  - `bypassPermissions` — 쉘 명령 포함 전부 자동 실행. 편하지만 위험. 텔레그램으로 보낸 한 줄이
    네 맥에서 무엇이든 실행할 수 있다는 뜻이니 신중히.
- `config.json`, `state.json`은 `.gitignore`에 포함됨 (토큰 커밋 방지).
