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

## 5. 실행 방법

| 방법 | 터미널 닫으면 | 재부팅 후 | 크래시 시 | 용도 |
|---|---|---|---|---|
| `node bot.mjs` | 종료됨 | ✗ | ✗ | 테스트·chatId 확인 |
| `nohup node bot.mjs > bot.log 2>&1 &` | 유지 | ✗ | ✗ | 임시 백그라운드 |
| **launchd (LaunchAgent)** | 유지 | ✅ 자동 시작 | ✅ 자동 재시작 | **상시 가동 (권장)** |

> `node bot.mjs &` 도 백그라운드로 돌긴 하지만 터미널을 닫으면 SIGHUP으로 같이 죽음.
> 터미널을 닫아도 유지하려면 최소 `nohup`, 재부팅·크래시까지 견디려면 launchd.

---

## 6. 항상 켜두기 (launchd 설정)

맥 재부팅·크래시에도 자동으로 살아나는 상시 가동 방식. 로그인 세션에서 도는
**LaunchAgent**라서 claude의 키체인/OAuth 인증을 그대로 사용함.

### 6-1. plist 확인 (경로/노드 버전 점검)

`com.cube.claudebot.plist`는 아래 경로들을 가정함. 다르면 먼저 수정:

```sh
which node     # ProgramArguments 첫 줄의 node 경로와 일치하는지
which claude   # PATH 에 이 디렉토리가 포함됐는지 (EnvironmentVariables)
```

plist에서 확인할 항목:
- `ProgramArguments` 1번째 — node 절대경로
- `ProgramArguments` 2번째 — `bot.mjs` 절대경로
- `WorkingDirectory` — 프로젝트 폴더
- `EnvironmentVariables > PATH` — nvm node/claude 경로 포함
- `StandardOutPath` / `StandardErrorPath` — 로그 파일 경로

### 6-2. 등록 & 시작

```sh
cd /Users/jtchoi/Projects/cube-brain-trainer/tools/claude-telegram-bot
cp com.cube.claudebot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cube.claudebot.plist
```

> macOS 최신 버전은 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cube.claudebot.plist`
> 형식을 권장하기도 함. `load`가 동작하지 않으면 이 명령을 사용.

### 6-3. 상태 확인 & 관리

```sh
launchctl list | grep claudebot      # 등록·동작 확인 (PID가 보이면 실행 중)
tail -f bot.log                      # 실행 로그
tail -f bot.error.log                # 에러 로그

# 중지
launchctl unload ~/Library/LaunchAgents/com.cube.claudebot.plist

# 코드 수정 후 재시작 (unload → load)
launchctl unload ~/Library/LaunchAgents/com.cube.claudebot.plist
launchctl load   ~/Library/LaunchAgents/com.cube.claudebot.plist
```

### 6-4. 자주 겪는 문제

- **`launchctl list`에 PID 없이 에러 코드만 보임** → `bot.error.log` 확인. 보통 node/claude
  경로 문제(`command not found`)거나 `config.json` 누락.
- **봇이 응답 없음** → claude 인증 만료일 수 있음. 터미널에서 `node bot.mjs` 직접 실행해
  `claude` 로그인 상태부터 확인.
- **맥이 잠자기 모드면 폴링도 멈춤** → 시스템 설정 > 배터리/전원에서 절전 해제 권장.
- **"폴링 오류" 반복 (ETIMEDOUT)** → 일부 네트워크에서 IPv6 경로가 막혀 Node의 fetch가
  api.telegram.org(IPv6 보유)에서 타임아웃나는 문제. `bot.mjs`가 IPv4 우선
  (`dns.setDefaultResultOrder('ipv4first')` + 자동선택 끄기)으로 이미 회피하도록 돼 있음.
  그래도 안 되면 `curl https://api.telegram.org` 로 네트워크/방화벽부터 확인.

---

## ⚠️ 보안 주의

- **반드시 `allowedChatId`를 설정**할 것. 안 하면 봇 토큰을 아는 누구나 네 맥에서 명령 실행 가능.
- `permissionMode`:
  - `acceptEdits` — 파일 편집은 자동 승인, 그 외(쉘 등)는 제한. 비교적 안전.
  - `bypassPermissions` — 쉘 명령 포함 전부 자동 실행. 편하지만 위험. 텔레그램으로 보낸 한 줄이
    네 맥에서 무엇이든 실행할 수 있다는 뜻이니 신중히.
- `config.json`, `state.json`은 `.gitignore`에 포함됨 (토큰 커밋 방지).
