# Claude Telegram Bot

**한국어** · [English](./README.md)

텔레그램으로 메시지를 보내면, 집이나 서버에 켜둔 Claude Code가 작업하고 결과를 다시 텔레그램으로 돌려주는 봇입니다.

```
[나] → 텔레그램 → bot.mjs → claude -p (작업 폴더) → 결과 → 텔레그램
```

## 왜 만들었나

자리를 비운 사이에도 폰으로 빌드를 돌려보거나 간단한 수정을 맡기고 싶을 때가 있습니다. 그렇다고 외부에서 데스크톱에 원격 접속해서 터미널을 여는 건 번거롭죠.

텔레그램 봇이면 충분합니다. 메시지를 보내면 집(또는 개인 서버)의 `claude`가 헤드리스로 돌아 작업하고, 답을 채팅으로 보내줍니다. 별도 웹 대시보드도, 추가 서버도 없습니다. 파일 하나(`bot.mjs`)와 설정 파일 하나가 전부입니다.

## 이런 분께

- 외출·이동 중에 폰으로 테스트나 빌드를 돌려보고 싶은 분
- 자리를 비운 사이 간단한 수정·커밋을 맡겨두고 싶은 분
- 맥미니나 홈서버에 띄워두고 어디서든 접속하고 싶은 분
- 거창한 셀프호스트 구성 없이 텔레그램만으로 끝내고 싶은 분

OpenClaw처럼 웹 UI까지 갖춘 구성을 써봤다면, 이 프로젝트는 그 반대편이라고 보면 됩니다. 대시보드도 데이터베이스도 없고, 이미 설치해 로그인해 둔 `claude` CLI를 그대로 불러 쓰는 게 전부입니다. 설정과 코드를 30초면 훑어볼 수 있습니다.

## 동작 방식

- 텔레그램 봇 API를 롱폴링으로 받습니다.
- 메시지가 오면 작업 폴더(`projectDir`)에서 `claude -p`(헤드리스 모드)를 실행합니다.
- 세션은 `--resume`으로 이어지므로, 봇을 재시작해도 대화 맥락이 유지됩니다.
- 의존성이 없습니다. Node 18+ 내장 기능(`fetch`, `child_process`)만 씁니다.

## 다른 도구와 비교

이 분야에는 이미 여러 도구가 있고, Anthropic도 공식 기능을 내놨습니다. 용도에 맞게 고르시면 됩니다.

| | 이 봇 | [공식 Claude Code Channels](https://code.claude.com/docs/en/channels) | [claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) |
|---|---|---|---|
| 런타임 | Node 내장만 | Bun + MCP 플러그인 | Python 3.11+ |
| 실행 모델 | 메시지마다 `claude -p` | 떠 있는 세션에 이벤트 push | Claude SDK / CLI |
| 상시 가동 | 백그라운드 데몬 | 인터랙티브 세션 유지 | 서비스 / 데몬 |
| 권한 차등 페르소나 | 가능 | 불가 | 불가 |
| 작업별 권한 승인 버튼 | 없음 | 있음 | 일부 |
| 기능 범위 | 최소 | 중간 | 많음 |

정리하면 이렇습니다.

- 작업마다 승인 버튼이 필요하고 세션을 계속 띄워둬도 괜찮다면 → **공식 Channels**
- 웹훅, cron, 음성 등 기능이 많이 필요하다면 → **claude-code-telegram**
- 구성을 최대한 단순하게 가져가고 싶거나, 한 코드로 여러 페르소나 봇을 굴리고 싶다면 → **이 봇**

## 요구 사항

- Node.js 18 이상 (내장 `fetch` 사용)
- `claude` CLI 설치 및 로그인 (봇은 이 인증을 그대로 씁니다)
- 텔레그램 봇 토큰 ([@BotFather](https://t.me/BotFather)에서 발급)

상시 가동 예시는 macOS의 launchd 기준입니다. 리눅스라면 systemd나 pm2로 같은 구성을 만들면 됩니다.

## 설치 & 실행

라이브러리가 아니라 단독으로 도는 CLI입니다. `import`해서 쓰는 게 아니라, 전역으로 설치하거나 `npx`로 실행합니다. 작업 폴더는 설정의 `projectDir`로 정하므로, 봇을 어디에 설치하든 상관없습니다.

**npx로 바로 실행**

```sh
npx claude-telegram-bot init        # 현재 폴더에 config.json 생성
# config.json 편집 (token, projectDir 등)
npx claude-telegram-bot             # config.json 으로 실행
```

**전역 설치 (상시 가동에 권장)**

```sh
npm i -g claude-telegram-bot

claude-telegram-bot init ~/botconfigs/myproj    # 해당 경로에 config.json 생성
# config.json 편집
claude-telegram-bot ~/botconfigs/myproj/config.json
```

> **설정 파일은 git에 올리지 마세요.** config 파일에는 봇 토큰이 들어 있습니다. git 레포 안에 둔다면 `config.json`, `state*.json`, `attachments/`를 그 프로젝트의 `.gitignore`에 추가하세요. 이 레포는 해당 패턴을 이미 무시하므로 `claudebot.config.json` 같은 이름도 안전하지만, 다른 프로젝트는 직접 지정해야 합니다.

## 설정

`config.json`의 키는 다음과 같습니다.

| 키 | 설명 |
|---|---|
| `token` | BotFather에서 받은 봇 토큰 |
| `allowedChatId` | 처음엔 비워두세요. 봇이 chatId를 알려줍니다 (아래 첫 실행 참고) |
| `projectDir` | Claude가 작업할 폴더의 절대경로 |
| `claudeBin` | `which claude` 결과 (절대경로 권장) |
| `permissionMode` | `plan`(읽기·계획만) / `acceptEdits`(편집 자동 승인) / `bypassPermissions`(쉘 포함 전부 자동) |
| `model` | 비우면 기본 모델. `opus`, `sonnet` 등 |
| `lang` | (선택) UI 언어. 비우면 사용자별 자동 판별(기본 영어, 텔레그램이 한국어면 한국어). `"en"`/`"ko"`로 고정 가능 |
| `name` | (선택) `/help`에 표시되는 봇 이름. 여러 봇 구분용 |
| `persona` | (선택) 역할 시스템 프롬프트. 페르소나 봇 정의용 |
| `appendSystemPrompt` | (선택) 기본 "간결하게 답하기" 지침을 직접 덮어쓸 때 |
| `env` | (선택) `claude` 프로세스에 넘길 환경 변수 |
| `schedule` | (선택) 정해진 시각에 프롬프트를 실행하는 cron 작업 — [예약 작업](#예약-작업-cron) 참고 |

`state.json`과 첨부 파일(`attachments/`)은 config 파일과 같은 폴더에 저장됩니다. 그래서 config만 따로 두면 프로젝트끼리 섞이지 않습니다.

## 첫 실행

1. **봇 토큰 발급** — 텔레그램에서 [@BotFather](https://t.me/BotFather)에게 `/newbot`을 보내고, 이름과 username(`_bot`으로 끝나야 함)을 정하면 토큰을 줍니다. `config.json`의 `token`에 넣고 `allowedChatId`는 비워둡니다.
2. **chatId 확인 후 잠그기** — 봇을 실행하고 텔레그램에서 아무 메시지나 보내면, 봇이 이 채팅의 `chatId`를 답장합니다. 그 숫자를 `allowedChatId`에 넣고 재시작하면 나만 쓸 수 있습니다. ([보안](#보안) 참고 — 이게 유일한 인증 수단입니다.)
3. **사용** — 그냥 메시지를 보냅니다.
   - `테스트 돌려보고 통과하면 커밋하고 push 해줘`
   - `api.ts 에 에러 핸들링 추가해줘`

명령어: `/new`(맥락 초기화) · `/cron`(예약 작업 보기·추가·삭제) · `/restart`(문법 검사 후 재시작) · `/status`(봇 상태·버전) · `/id`(채팅 ID 확인) · `/help`(도움말)

> **`/restart`** 는 먼저 `bot.mjs` 에 `node --check` 를 돌려 **문법 오류가 있으면 재시작을 취소**합니다(잘못된 수정이 봇을 크래시 루프에 빠뜨리는 것 방지). 통과하면 프로세스를 종료하고, 다시 띄우는 건 프로세스 관리자에게 맡깁니다. [launchd 설정](#상시-실행-launchd)(`KeepAlive`)이면 바로 동작하고, 관리자 없이 `node bot.mjs` 로만 돌리면 그냥 멈춥니다. 재시작 후 대화 세션은 `state.json` 의 ID로 이어집니다.

## 사용 메모

- **세션 유지** — 대화는 `--resume`으로 자동으로 이어집니다. 마지막 세션 ID가 `state.json`에 저장되므로 봇을 재시작해도 맥락이 남습니다. 새로 시작하려면 `/new`.
- **간결한 답변** — 텔레그램에 맞게 짧게 답하도록 시스템 프롬프트가 기본으로 붙습니다. 바꾸려면 `appendSystemPrompt`에 직접 넣으세요 (빈 문자열이면 끔).
- **언어** — 봇 자체 문구(`/help`, 명령 메뉴, 상태 메시지)는 **기본 영어**, 텔레그램이 한국어인 사용자에겐 한국어로 나옵니다. `lang`(`"en"`/`"ko"`)으로 고정할 수 있습니다. Claude의 실제 답변은 **사용자가 쓴 언어**를 따라갑니다. `/` 명령 메뉴는 `setMyCommands`로 언어별 등록됩니다.
- **서식 변환** — 답변의 마크다운(굵게·코드·표 등)을 텔레그램 HTML로 바꿔 보냅니다. 변환이 깨지는 경우엔 평문으로 다시 보냅니다.
- **첨부 파일** — 사진·문서·음성·영상을 보내면 `attachments/`에 내려받고, 그 경로를 Claude에게 전달합니다(캡션도 함께). 이미지는 Read로 열어볼 수 있습니다.

## 예약 작업 (cron)

config에 `schedule` 배열을 두면 정해진 시각에 프롬프트를 자동 실행합니다 — 아침 브리핑, 주기적 점검, 리마인더 등. 각 항목은 프롬프트를 실행하고 결과를 `allowedChatId`로 보냅니다.

```json
"schedule": [
  { "cron": "0 9 * * 1-5", "label": "아침 브리핑", "prompt": "오늘 처리할 이슈/할 일을 요약해줘" },
  { "cron": "*/30 * * * *", "prompt": "CI 상태 확인해서 빨간 게 있을 때만 알려줘" }
]
```

- **`cron`** — 표준 5필드 `분 시 일 월 요일` (예: `0 9 * * 1-5` = 평일 09:00). `*`, 목록(`1,3,5`), 범위(`1-5`), 스텝(`*/15`)을 지원합니다. 요일 `0`과 `7`은 둘 다 일요일. 시각은 **호스트의 로컬 시간대** 기준입니다. 외부 의존성 없이 파서가 `bot.mjs` 안에 들어 있습니다.
- **`prompt`**(필수) — Claude에게 보낼 메시지. **`label`**(선택) — 답장 푸터와 `/cron` 목록에 표시되는 짧은 이름.
- **새 세션** — 예약 작업은 **독립된 세션**으로 돌아가서 내 대화 맥락을 오염시키지 않습니다(`state.json`은 내 것 그대로). 단일 작업 락을 공유하므로, 발사 시점에 다른 작업이 진행 중이면 그 회차는 **건너뜁니다**(로그 남김).
- **조용한 작업(조건부 알림)** — Claude의 출력이 **비었거나 정확히 `SKIP`**이면 그 회차는 텔레그램으로 **아무것도 보내지 않습니다**. "조건이 맞을 때만 알리고 평소엔 조용히" 하고 싶을 때, 프롬프트에 *"조건이 아니면 다른 말 없이 `SKIP`만 출력해"* 라고 적으면 됩니다. 자주 도는 작업(예: 5분마다)도 스팸 없이 쓸 수 있습니다.

**채팅에서 자연어로 추가하기**

```
/cron add 매일 아침 9시에 열린 이슈 요약해줘
```

봇이 이 문장을 Claude에게 보내 cron 표현식으로 바꾸고, **해석한 내용을 되돌려 보여줍니다**(잘못 읽었으면 바로 확인 가능). 그리고 `state.json`에 저장하므로 **재시작이 필요 없습니다**. 동적 작업에는 번호가 붙고, 다음으로 관리합니다.

- `/cron` — 전체 목록 (config 작업은 `[config]`, 동적 작업은 `#번호`로 표시)
- `/cron add <자연어 요청>` — 예: `/cron add 30분마다 CI 빨간 거 있으면 알려줘`
- `/cron rm <번호>` — 동적 작업 삭제 (config 작업은 파일에서 수정)

config에 적은 작업은 바꾸려면 재시작이 필요하고, 채팅으로 추가한 작업만 즉시 반영됩니다.

## 여러 프로젝트 / 페르소나

코드는 프로젝트에 종속되지 않습니다. config 파일만 하나씩 더 만들면 여러 봇을 동시에 굴릴 수 있습니다.

```sh
claude-telegram-bot ~/projects/A/claudebot.config.json   # 프로젝트 A
claude-telegram-bot ~/projects/B/claudebot.config.json   # 프로젝트 B
```

- 텔레그램은 토큰 하나당 폴링 하나만 허용합니다. 그래서 봇마다 BotFather 토큰을 따로 발급해야 합니다.
- `state`와 `attachments`는 config 옆에 저장되므로 봇끼리 섞이지 않습니다.

**같은 프로젝트**를 역할별 봇으로 나눌 수도 있습니다. 예를 들어 개발자 봇과 기획자 봇으로요. 코드는 그대로 두고 config만 역할별로 둡니다.

| 봇 | permissionMode | 역할 |
|---|---|---|
| 개발자 | `bypassPermissions` | 구현·수정·테스트·git |
| 기획자 | `plan` | 기능 제안·스펙·UX 방향 |

- `persona`에 역할 프롬프트를 넣으면 그 봇의 정체성이 됩니다. (텔레그램용 간결 지침은 자동으로 같이 붙습니다.)
- 같은 폴더를 공유한다면 쉘을 쓰는 봇(`bypassPermissions`)은 하나로 제한하는 편이 안전합니다. 동시 편집 충돌을 피할 수 있습니다.
- `state` 파일 이름은 config 이름에서 만들어집니다 (`dev.config.json` → `dev.config.state.json`). 같은 폴더에 config가 여러 개여도 맥락이 안 섞입니다.

## 상시 실행 (launchd)

맥을 재부팅하거나 봇이 죽어도 자동으로 다시 뜨게 하려면 launchd를 씁니다. 로그인 세션에서 도는 LaunchAgent라서 `claude`의 키체인/OAuth 인증을 그대로 사용합니다.

저장소의 `com.claudebot.example.plist`를 복사해 쓰면 됩니다. 먼저 경로부터 확인하세요.

```sh
which node     # ProgramArguments 첫 줄의 node 경로와 같은지
which claude   # 이 경로가 PATH(EnvironmentVariables)에 포함됐는지
```

plist에서 맞춰야 할 항목:

- `ProgramArguments` — node 절대경로, `bot.mjs` 절대경로, config 절대경로
- `WorkingDirectory` — 작업 폴더
- `EnvironmentVariables > PATH` — node·claude 경로 포함
- `StandardOutPath` / `StandardErrorPath` — 로그 파일 경로
- `Label` — 봇마다 고유하게 (예: `com.claudebot.myproj`)

등록과 관리:

```sh
cp com.claudebot.example.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist

launchctl list | grep claudebot      # 상태 확인 (PID가 보이면 실행 중)
tail -f bot.log                      # 로그

# 중지
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist

# 코드 수정 후 재시작
launchctl bootout   gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudebot.example.plist
```

> 최신 macOS는 `bootstrap`/`bootout`을 권장합니다. 구버전 `load`/`unload`도 동작하지만 deprecated 경고가 뜰 수 있습니다.

## 자주 겪는 문제

- **`launchctl list`에 PID 없이 에러 코드만 보임** — `bot.error.log`를 확인하세요. 보통 node/claude 경로 문제이거나 config 누락입니다.
- **봇이 응답하지 않음** — `claude` 인증이 만료됐을 수 있습니다. 터미널에서 `node bot.mjs`를 직접 실행해 로그인 상태부터 확인하세요.
- **맥이 잠자기에 들어가면 폴링도 멈춤** — 시스템 설정 > 배터리/전원에서 절전을 풀어두세요.
- **폴링 오류 반복 (ETIMEDOUT)** — 일부 네트워크는 IPv6 경로가 막혀 있어 `fetch`가 타임아웃 납니다. `bot.mjs`는 IPv4를 우선하도록 이미 처리해 뒀습니다. 그래도 안 되면 `curl https://api.telegram.org`로 네트워크부터 확인하세요.

## 보안

이 봇은 **채팅으로 받은 메시지를 머신에서 명령으로 실행합니다.** 편한 만큼 위험하니 아래는 꼭 지키세요.

**누가 명령을 실행할 수 있나**

- **허가된 채팅** — `allowedChatId`로 허용한 텔레그램 계정에 접근할 수 있는 사람. 폰 잠금과 텔레그램 2FA를 켜두세요.
- **봇 토큰을 가진 사람** — 토큰은 봇의 비밀번호입니다. 토큰만으로 메시지를 읽고 봇을 사칭할 수 있습니다. `allowedChatId`가 명령 실행은 막아주지만(텔레그램이 주는 chatId는 위조 불가), 토큰이 새면 사고로 보고 `@BotFather`의 `/revoke`로 폐기하세요.
- **프롬프트 인젝션** — 외부 웹페이지나 파일을 봇에 넘겨 처리시키면, 그 안에 숨은 지시가 Claude를 조종할 수 있습니다. 신뢰할 수 없는 내용을 `bypassPermissions` 봇에 그대로 넣지 마세요.

**꼭 지킬 것**

- `allowedChatId`를 반드시 설정하세요. 설정 전에는 봇이 아무것도 실행하지 않고 chatId만 알려줍니다. 이게 유일한 인증 수단입니다.
- 토큰을 자격증명처럼 다루세요. 이슈·로그·스크린샷에 붙여넣지 마세요. 시작 로그는 토큰을 `<redacted>`로 가립니다.
- 샌드박스는 없습니다. 봇은 `claude`를 내 계정 권한으로 실행합니다. 내 파일, SSH/git 자격증명, Claude 인증 세션에 그대로 접근합니다.

**권한 모드 선택**

| 모드 | 허용 범위 | 권장 상황 |
|---|---|---|
| `plan` | 읽기·계획만 | Q&A, 코드 리뷰, 기획자 페르소나 |
| `acceptEdits` | 파일 편집 자동, 쉘 등은 제한 | 기본값으로 무난 |
| `bypassPermissions` | 쉘 포함 전부 자동 | 채팅 한 줄이 임의 코드 실행임을 감수할 때 |

- 자율 쉘·git이 꼭 필요한 게 아니면 `acceptEdits`를 쓰세요.
- `projectDir`는 홈 디렉터리가 아니라 특정 프로젝트를 가리키게 해 피해 범위를 줄이세요.
- 페르소나 봇을 여럿 둘 땐 하나만 `bypassPermissions`로 두고 나머지는 `plan`으로.
- 상시 가동한다면 전용 계정이나 VM도 고려해 보세요.

보안 이슈는 공개로 올리기보다 GitHub 이슈(민감한 내용은 메인테이너에게 비공개)로 알려주세요.

## 라이선스

MIT © Jongtaek Choi
