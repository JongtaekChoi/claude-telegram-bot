# Claude Telegram Bot (범용)

**한국어** · [English](./README.md)

텔레그램 메시지를 받아 지정한 프로젝트 폴더에서 `claude -p`(헤드리스 모드)를 실행하고
결과를 다시 텔레그램으로 보내주는 작은 브릿지. 의존성 없음 (Node 18+ 내장 기능만 사용).

```
[너] → Telegram → bot.mjs → claude -p (config.projectDir) → 결과 → Telegram
```

검증 완료: `bypassPermissions` 헤드리스 모드 정상 동작 확인. 쉘·git·테스트까지 자동 실행됨.

> ### ⚠️ 이 도구는 설계상 원격 코드 실행 도구입니다. 실행 전에 [보안](#-보안) 섹션을 꼭 읽으세요.
> 텔레그램으로 보낸 메시지는 봇이 도는 머신에서 **명령으로 실행**됩니다.
> `permissionMode: bypassPermissions`면 한 줄짜리 메시지가 네 계정 권한으로 **무엇이든** 실행할 수 있습니다.

## 여러 프로젝트 동시 운영

이 코드는 프로젝트 비종속이라, **프로젝트마다 config 파일 하나씩**만 만들면 여러 개를 동시에 돌릴 수 있다.

- 실행: `node bot.mjs /절대경로/프로젝트.config.json` (인자 없으면 같은 폴더의 `config.json`)
- 상태(`state.json`)·첨부(`attachments/`)는 **그 config 파일이 있는 폴더**에 저장돼 프로젝트끼리 안 섞임
- **주의**: 텔레그램은 토큰당 폴링 1개만 허용 → 프로젝트마다 **BotFather 토큰을 따로** 만들어야 동시 운영 가능
- 상시 가동은 `com.claudebot.example.plist`를 프로젝트별로 복사해 등록 (아래 launchd 섹션 참고)

예) 두 프로젝트:
```
~/projects/A/claudebot.config.json   (토큰 A, projectDir=~/projects/A)
~/projects/B/claudebot.config.json   (토큰 B, projectDir=~/projects/B)
node bot.mjs ~/projects/A/claudebot.config.json   # 인스턴스 A
node bot.mjs ~/projects/B/claudebot.config.json   # 인스턴스 B
```

## 여러 페르소나(역할) 봇

**같은 프로젝트**를 역할별 봇으로 나눠 띄울 수 있다 (예: **개발자** + **기획자**).
코드는 하나, **config 파일만 역할별로** 따로 둔다.

- **`persona`**: config에 역할 시스템 프롬프트를 넣으면 그 봇의 정체성이 된다.
  텔레그램용 간결 지침은 자동으로 함께 주입되므로 `persona`엔 역할만 적으면 됨.
- **`permissionMode`로 권한 차등**: 같은 폴더를 공유하므로 **셸을 쓰는 봇(`bypassPermissions`)은
  하나로 제한**하면 동시 편집 충돌을 피할 수 있다. 읽기·계획만 시키려면 `plan`.
- **세션 분리**: `state` 파일은 config 이름에서 파생된다
  (`config.json`→`state.json`, `dev.config.json`→`dev.config.state.json`). 같은 폴더에
  config 여러 개를 둬도 봇끼리 맥락이 안 섞임.
- **봇마다 토큰 1개**: 각 봇은 BotFather에서 별도 토큰 발급 (`allowedChatId`는 동일해도 됨).

예) 개발자 + 기획자:
```
dev.config.json       (permissionMode: bypassPermissions, persona: "시니어 개발자...")
planner.config.json   (permissionMode: plan,              persona: "기획자 겸 UX 담당...")
node bot.mjs dev.config.json
node bot.mjs planner.config.json
```

| 봇 | permissionMode | 역할 |
|---|---|---|
| 개발자 | `bypassPermissions` | 코드 구현·수정·테스트·git |
| 기획자 | `plan` (읽기·계획만) | 기능 제안·스펙·UX/디자인 방향 |

> 상시 가동은 `com.claudebot.example.plist`를 **봇마다** 복사해 `Label`·config 인자·로그
> 경로를 다르게 등록한다 (아래 launchd 섹션 참고).

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
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cube.claudebot.plist
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
| `permissionMode` | `plan`(읽기·계획만) / `acceptEdits`(파일편집 자동승인) / `bypassPermissions`(전부 자동, 쉘 포함) |
| `model` | 비워두면 기본 모델. `opus` / `sonnet` 등 |
| `name` | (선택) `/help`에 표시되는 봇 이름 — 멀티 봇 구분용 |
| `persona` | (선택) 역할 시스템 프롬프트 — 페르소나(개발자/기획자 등) 정의. 자세히는 아래 페르소나 섹션 |

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

### 응답 형식 / 첨부

- **간결 모드**: 텔레그램용으로 짧게 답하도록 `--append-system-prompt`가 기본 적용됨.
  지침을 바꾸려면 `config.json`의 `appendSystemPrompt`에 문자열을 넣으면 됨(빈 문자열이면 비활성).
- **서식**: 응답의 마크다운(굵게/코드/제목/표)을 텔레그램 HTML로 변환해 전송함.
  변환이 실패하는 예외 케이스는 자동으로 평문으로 재전송됨.
- **파일 첨부**: 사진/문서/음성/영상을 보내면 `attachments/`에 내려받아 그 경로를
  Claude에게 전달함(캡션은 메시지로 같이 전달). 이미지도 Read로 열어볼 수 있음.

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
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cube.claudebot.plist
```

> 최신 macOS 권장 방식은 `bootstrap`/`bootout`. 구버전(`load`/`unload`)도 동작하지만
> deprecated 경고가 뜰 수 있음. `bootstrap`이 안 되면 `launchctl load ~/Library/LaunchAgents/com.cube.claudebot.plist`로 대체.

### 6-3. 상태 확인 & 관리

```sh
launchctl list | grep claudebot      # 등록·동작 확인 (PID가 보이면 실행 중)
tail -f bot.log                      # 실행 로그
tail -f bot.error.log                # 에러 로그

# 중지
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cube.claudebot.plist

# 코드 수정 후 재시작 (bootout → bootstrap)
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.cube.claudebot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cube.claudebot.plist
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

## ⚠️ 보안

**이 도구는 채팅 앱 안에 들어있는 SSH 키라고 생각하라.** 명령을 실행하는 게 목적이고,
그 힘이 곧 위험이다. 노출 전에 반드시 읽을 것.

### 위협 모델 — 누가 네 머신에서 명령을 실행할 수 있나

1. **허가된 채팅.** `allowedChatId`로 허용한 텔레그램 계정에 접근 가능한 사람은 명령을 실행할 수 있다.
   폰 잠금과 텔레그램 계정 2단계 인증(2FA)을 켜둘 것.
2. **봇 토큰을 가진 사람.** 토큰은 봇의 비밀번호다. 토큰만 있으면 들어오는 메시지를 읽고 봇을 사칭할 수
   있다. `allowedChatId` 화이트리스트가 명령 *실행*은 여전히 막아주지만(텔레그램이 부여하는 `chatId`는
   위조 불가), **토큰 유출은 사고로 취급**하라. `@BotFather` → `/revoke`로 폐기하고 새로 발급할 것.
3. **프롬프트 인젝션.** 웹페이지·파일·이슈 내용을 봇에 넘기며 처리시키면, 그 안에 숨은 악성 지시가
   Claude를 조종할 수 있다. 신뢰할 수 없는 콘텐츠를 `bypassPermissions` 봇에 그대로 흘려넣지 말 것.

### 타협 불가 원칙

- **`allowedChatId`는 반드시 설정.** 설정 전에는 봇이 아무 것도 실행하지 않고 채팅 ID만 알려준다.
  설정 후에는 그 채팅만 명령 가능 — 이게 유일한 인증 계층이므로 반드시 채워야 한다.
- **토큰을 자격증명처럼 보호.** `config.json`·`state.json`은 `.gitignore`에 있어 커밋되지 않는다 —
  그대로 둘 것. 토큰을 이슈·로그·스크린샷에 절대 붙여넣지 말 것. 시작 로그는 토큰을 가린다
  (`token: <redacted>`) — 되살리지 말 것.
- **샌드박스는 없다.** 봇은 `claude`를 *네* 계정 권한으로 실행한다. 네 파일시스템, SSH/git 자격증명,
  Claude OAuth/키체인 세션에 그대로 접근한다. 네가 할 수 있는 건 봇도 할 수 있다.

### 감당 가능한 최소 권한을 선택하라

`permissionMode`가 핵심 안전 다이얼이다:

| 모드 | 허용 범위 | 권장 상황 |
|---|---|---|
| `plan` | 읽기·계획만, 편집 없음 | Q&A, 코드 리뷰, "기획자" 페르소나 |
| `acceptEdits` | 파일 편집 자동 승인, 그 외(쉘 등)는 제한 | **권장 기본값** — 유용하면서 범위 제한 |
| `bypassPermissions` | **임의 쉘 포함** 전부 자동 실행 | 채팅 한 줄 = 임의 코드 실행을 감수할 때 |

실전 강화 팁:

- 자율 쉘/git이 꼭 필요한 게 아니면 `bypassPermissions`보다 `acceptEdits`를 쓸 것.
- `projectDir`는 홈 디렉터리가 아니라 **특정 프로젝트**를 가리키게 해 피해 범위를 줄일 것.
- 멀티 페르소나에서는 **하나의** 봇만 `bypassPermissions`로 두고 나머지는 `plan`으로.
- 상시 가동할 거면 전용 사용자 계정이나 VM에서 돌리는 것도 고려.

### 취약점 신고

보안 이슈를 발견하면 익스플로잇 세부를 공개로 올리기보다 GitHub 이슈(민감한 건 메인테이너에게 비공개
연락)로 알려주세요.
