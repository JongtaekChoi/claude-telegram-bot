# Claude Telegram Bot

**한국어** · [English](./README.md)

[![npm version](https://img.shields.io/npm/v/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![npm downloads](https://img.shields.io/npm/dm/claude-telegram-bot.svg)](https://www.npmjs.com/package/claude-telegram-bot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

텔레그램으로 Claude Code를 실행하세요 — 폰에서 테스트를 돌리고, 파일 수정을 맡기고, 계획을 검토할 수 있습니다.

**이미 로그인해 둔 `claude` CLI를 텔레그램으로 호출하는 zero-dependency 데몬 봇입니다.**
웹 대시보드도, 데이터베이스도, Python/Bun 서비스도 없습니다. 메시지를 받으면 작업 폴더에서 headless `claude -p`를 실행하고 결과를 다시 텔레그램으로 보냅니다.

```
[나] → 텔레그램 → bot.mjs → claude -p (작업 폴더) → 결과 → 텔레그램
```

> ### ⚠️ 의도적으로 원격 코드 실행 도구입니다
> 텔레그램 메시지가 호스트 머신의 코드 실행으로 이어질 수 있습니다. 처음에는 `permissionMode: acceptEdits`로 시작하고, 반드시 `allowedChatId`를 설정하세요. 상시 실행 전에 [보안](#보안)을 읽어주세요.

## 3분 빠른 시작

필요한 것: **Node.js 18+**, 설치·로그인된 **Claude Code `claude` CLI**, `@BotFather`에서 받은 텔레그램 봇 토큰.

```sh
npm i -g claude-telegram-bot
claude-telegram-bot init ~/botconfigs/my-project
```

`~/botconfigs/my-project/mybot.json`을 수정합니다.

```json
{
  "token": "BOT_TOKEN_FROM_BOTFATHER",
  "allowedChatId": "",
  "projectDir": "/ABSOLUTE/PATH/TO/PROJECT",
  "claudeBin": "/ABSOLUTE/PATH/TO/claude",
  "permissionMode": "acceptEdits"
}
```

처음 한 번 실행해서 chat ID를 확인합니다.

```sh
claude-telegram-bot ~/botconfigs/my-project/mybot.json
```

텔레그램 봇에 아무 메시지나 보내면 봇이 `chatId`를 알려줍니다. 그 값을 `allowedChatId`에 넣고 재시작한 뒤, 이렇게 요청해보세요.

```text
테스트 돌려보고 실패한 부분 요약해줘
```

설치 없이 시험하려면 `npx claude-telegram-bot init`, `npx claude-telegram-bot`을 사용하면 됩니다.

## 왜 만들었나

자리를 비운 사이에도 폰으로 빌드를 돌려보거나 간단한 수정을 맡기고 싶을 때가 있습니다. 외부에서 데스크톱에 원격 접속하거나 SSH를 여는 건 번거롭죠. 텔레그램 봇이면 충분합니다.

이 프로젝트는 맥미니, 홈서버, 개발 머신, 개인 VPS처럼 이미 신뢰하는 환경에 띄워두고 쓰는 작은 도구입니다. 이미 설치해 로그인해 둔 `claude` CLI를 그대로 재사용합니다.

## 이런 분께

- 외출·이동 중에 폰으로 테스트나 빌드를 돌려보고 싶은 분
- 자리를 비운 사이 간단한 수정·커밋을 맡겨두고 싶은 분
- 맥미니나 홈서버에 Claude Code를 띄워두고 싶은 분
- 웹 UI, DB, 별도 서버 없이 텔레그램만으로 끝내고 싶은 분
- 같은 프로젝트를 개발자/기획자 같은 역할별 봇으로 나누고 싶은 분

## 특징

- **의존성 없음** — Node 18+ 내장 기능만 사용합니다.
- **상시 실행 친화적** — macOS `launchd` 템플릿 포함.
- **Headless Claude Code** — 메시지마다 `projectDir`에서 `claude -p` 실행.
- **세션 유지** — 재시작 후에도 `--resume`으로 대화가 이어지고, `/new`로 초기화.
- **계획 승인 플로우** — `/plan <요청>`으로 읽기 전용 계획을 먼저 받고 진행/취소.
- **여러 프로젝트/페르소나** — config 파일을 프로젝트·역할별로 분리.
- **첨부 파일 지원** — 사진, 문서, 음성, 영상을 저장하고 Claude에게 경로 전달.
- **큐와 복구** — 작업 중 메시지 큐잉, 레이트 리밋 리셋 시각 예약 재시도.
- **로컬 폴백** — 필요 시 Ollama 모드/폴백 사용.

## 다른 도구와 비교

| | 이 봇 | [공식 Claude Code Channels](https://code.claude.com/docs/en/channels) | [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) |
|---|---|---|---|
| 런타임 | **Node 내장만** | Bun + MCP 플러그인 | Python 3.11+ |
| 실행 모델 | 메시지마다 `claude -p` | 열려 있는 `claude --channels` 세션에 이벤트 push | Claude SDK / CLI |
| 상시 가동 | **백그라운드 데몬** | 인터랙티브 세션 유지 | 서비스 / 데몬 |
| 권한 차등 페르소나 | **가능** | 불가 | 불가 |
| 작업별 승인 | `/plan` 검토 플로우 + config 권한 | **가능** | 일부 |
| 기능 범위 | 집중형 | 중간 | 많음 |

작업마다 세밀한 승인 버튼이 필요하고 세션을 계속 띄워도 괜찮다면 공식 Channels가 좋습니다. 웹훅, 음성, 내보내기 등 기능이 많아야 한다면 `claude-code-telegram`이 맞을 수 있습니다. 이 봇은 최소 구성, 읽기 쉬운 코드, 의존성 없는 데몬, 역할별 봇 구성을 원하는 경우에 맞습니다.

## 설치 & 실행

### 전역 설치 — 상시 실행에 권장

```sh
npm i -g claude-telegram-bot
claude-telegram-bot init ~/botconfigs/myproj
# token, allowedChatId, projectDir, claudeBin, permissionMode 수정
claude-telegram-bot ~/botconfigs/myproj/mybot.json
```

### npx — 설치 없이 시험

```sh
npx claude-telegram-bot init
# ./mybot.json 수정
npx claude-telegram-bot
```

config 파일을 프로젝트/역할별로 하나씩 만들면 여러 봇을 동시에 띄울 수 있습니다. state와 첨부 파일은 config 옆 `.claude-bot/`에 저장되어 서로 섞이지 않습니다.

> **설정 파일은 git에 올리지 마세요.** 텔레그램 봇 토큰이 들어 있습니다. 다른 저장소 안에 config를 둔다면 config 파일, `.claude-bot/`, `state*.json`, `attachments/`를 그 저장소의 `.gitignore`에 추가하세요.

## 주요 명령어

- `/new` — 대화 맥락 초기화, 새 세션 시작.
- `/compact` — 세션을 유지한 채 컨텍스트 압축.
- `/plan <요청>` — 읽기 전용 계획을 먼저 받고 진행/취소.
- `/stop` — 실행 중인 Claude 프로세스 중단. `/stop --reset`은 세션도 롤백.
- `/cron` — 예약 작업 보기/추가/삭제.
- `/reserve` — 사용량 한도 리셋 후 재시도 큐 확인/취소.
- `/restart` — `bot.mjs` 문법 검사 후 프로세스 재시작.
- `/status` — 봇 상태, 버전, 프로젝트, 세션, 권한 확인.
- `/model` — 모델 보기/전환.
- `/autocompact` — 자동 컴팩션 임계값 확인/설정.
- `/ollama` — 로컬 Ollama 채팅 모드 토글.
- `/id` — 현재 텔레그램 chat ID 표시.
- `/help` — 도움말 표시.

## 설정

```sh
cp config.example.json mybot.json
```

| 키 | 설명 |
|---|---|
| `token` | `@BotFather`에서 받은 봇 토큰 |
| `allowedChatId` | 처음엔 비워두세요. 봇이 chat ID를 알려줍니다. 설정 전에는 명령을 실행하지 않습니다. |
| `projectDir` | Claude가 작업할 프로젝트 절대경로 |
| `claudeBin` | `claude` 절대경로 (`which claude`) |
| `permissionMode` | `plan` / `acceptEdits` / `bypassPermissions` |
| `model` | 비우면 Claude 기본값. 또는 `haiku`, `sonnet`, `opus`, `fable`, 전체 모델 ID |
| `lang` | 비우면 자동. `"en"` / `"ko"`로 고정 가능 |
| `name` | `/help`에 표시할 봇 이름 |
| `persona` | 역할별 봇용 시스템 프롬프트 |
| `appendSystemPrompt` | 텔레그램용 간결 지침 덮어쓰기 |
| `env` | Claude 프로세스에 넘길 환경 변수 |
| `schedule` | cron 기반 예약 프롬프트 |
| `commands` | 쉘 스크립트를 실행하는 커스텀 `/명령어` |
| `ollamaFallback` | Claude 레이트 리밋/크레딧 부족 시 Ollama 폴백 |
| `ollamaModel` | Ollama 모델명. 기본값 `phi3:mini` |
| `autoCompactThreshold` | 자동 `/compact` 기준 토큰 수. `0`이면 비활성화 |

## 권한 모드

| 모드 | 허용 범위 | 권장 상황 |
|---|---|---|
| `plan` | 읽기·계획만, 편집 없음 | Q&A, 코드 리뷰, 기획자 봇 |
| `acceptEdits` | 파일 편집 자동 승인, 쉘 등은 제한 | **권장 기본값** |
| `bypassPermissions` | 쉘 포함 전부 자동 실행 | 채팅 한 줄이 임의 코드 실행임을 감수할 때 |

자율 쉘·git이 꼭 필요한 게 아니라면 `acceptEdits`를 쓰세요. 같은 프로젝트에 역할별 봇을 여러 개 띄운다면 `bypassPermissions` 봇은 하나만 두는 편이 안전합니다.

## 커스텀 명령어

config에 `commands`를 정의하면 프로젝트별 `/명령어`로 쉘 스크립트를 실행하고 결과를 받을 수 있습니다.

```json
"commands": {
  "deploy": { "run": "npm run deploy", "description": "프로덕션 배포" },
  "logs":   { "run": "tail -n 50 ./app.log", "description": "최근 로그" },
  "status": { "run": "git status && git log --oneline -5", "description": "Git 상태" }
}
```

명령어는 `projectDir`에서 실행되고, Claude 작업과 독립적으로 동작합니다. 뒤에 인자를 붙일 수 있으며, 출력은 4,000자, 타임아웃은 60초입니다.

## 예약 작업

`schedule` 배열을 두면 정해진 시각에 프롬프트를 자동 실행합니다.

```json
"schedule": [
  { "cron": "0 9 * * 1-5", "label": "아침 브리핑", "prompt": "오늘 처리할 이슈/할 일을 요약해줘" },
  { "cron": "*/30 * * * *", "prompt": "CI 상태 확인해서 빨간 게 있을 때만 알려줘. 아니면 SKIP만 출력해" }
]
```

cron은 표준 5필드 `분 시 일 월 요일` 형식이고, 호스트의 로컬 시간대를 사용합니다. Claude 출력이 비었거나 정확히 `SKIP`이면 텔레그램으로 아무것도 보내지 않습니다.

채팅에서 자연어로 추가할 수도 있습니다.

```text
/cron add 매일 아침 9시에 열린 이슈 요약해줘
```

## 여러 프로젝트와 페르소나

프로젝트마다 config를 나누면 됩니다.

```sh
claude-telegram-bot ~/projects/A/claudebot.config.json
claude-telegram-bot ~/projects/B/claudebot.config.json
```

텔레그램은 토큰 하나당 폴링 하나만 허용하므로, 실행 중인 봇마다 BotFather 토큰이 필요합니다. state 파일은 config 이름에서 만들어져 맥락이 분리됩니다.

같은 프로젝트도 역할별로 나눌 수 있습니다.

| 봇 | permissionMode | 역할 |
|---|---|---|
| 개발자 | `acceptEdits` 또는 `bypassPermissions` | 구현, 테스트, 커밋 |
| 기획자 | `plan` | 스펙, UX, 이슈 정리 |

## macOS launchd로 상시 실행

`com.claudebot.example.plist`를 사용하면 맥 재부팅이나 봇 크래시 후에도 자동으로 다시 실행할 수 있습니다. LaunchAgent로 돌기 때문에 기존 Claude 키체인/OAuth 인증을 그대로 씁니다.

먼저 경로를 확인합니다.

```sh
which node
which claude
```

복사하고, plist 안의 경로를 수정한 뒤 등록합니다.

```sh
cp com.claudebot.example.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist

launchctl list | grep claudebot
tail -f bot.log
tail -f bot.error.log

launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
```

봇을 여러 개 띄운다면 plist의 `Label`, config 경로, 로그 경로를 각각 다르게 설정하세요.

## 자주 겪는 문제

- **`launchctl list`에 PID 없이 에러 코드만 보임** — `bot.error.log`를 확인하세요. 보통 node/claude 경로 또는 config 문제입니다.
- **봇이 응답하지 않음** — `claude` 인증이 만료됐을 수 있습니다. 터미널에서 직접 실행해 로그인 상태를 확인하세요.
- **맥이 잠자기에 들어감** — 호스트가 잠들면 폴링도 멈춥니다. 상시 실행용이면 절전을 꺼두세요.
- **`ETIMEDOUT` 폴링 오류 반복** — 일부 네트워크는 IPv6 경로가 막혀 있습니다. 봇은 IPv4를 우선하지만, 그래도 안 되면 `curl https://api.telegram.org`로 네트워크를 확인하세요.
- **처음 실행했는데 아무 작업도 안 함** — `allowedChatId`를 설정해야 합니다. 설정 전에는 chat ID만 알려줍니다.

## 보안

이 봇은 텔레그램 안에 들어 있는 SSH 키처럼 다뤄야 합니다.

- 허용된 텔레그램 채팅에 접근할 수 있는 사람은 봇에게 작업을 시킬 수 있습니다.
- 봇 토큰을 가진 사람은 메시지를 읽거나 봇을 사칭할 수 있습니다. 유출되면 `@BotFather`에서 폐기하세요.
- 외부 파일, 웹페이지, 이슈 안의 프롬프트 인젝션이 Claude를 조종할 수 있습니다. 신뢰할 수 없는 내용을 높은 권한 봇에 넘기지 마세요.
- 샌드박스는 없습니다. Claude는 내 사용자 권한, 파일시스템, git/SSH 자격증명, Claude 인증 세션으로 실행됩니다.

실전 권장사항:

- 반드시 `allowedChatId`를 설정하세요.
- `bypassPermissions`보다 `acceptEdits`를 기본으로 쓰세요.
- `projectDir`는 홈 디렉터리가 아니라 특정 프로젝트를 가리키게 하세요.
- 상시 실행한다면 전용 사용자 계정이나 VM도 고려하세요.

## 개발

```sh
npm test
```

smoke test는 CLI 파일에 `node --check`를 실행하고, 두 바이너리가 버전을 출력하는지 확인합니다. CI는 Node 18, 20, 22에서 같은 검사를 실행합니다.

최근 변경 사항은 [CHANGELOG.md](./CHANGELOG.md)를 참고하세요.

## 라이선스

MIT © Jongtaek Choi
