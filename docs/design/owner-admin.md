# 오너 DM 어드민 — 방을 채팅에서 추가한다

## 배경

방을 하나 늘리려면 지금은 `config.json` 의 `allowedChatId` 를 손으로 고치고 봇을 재시작해야 한다.
**폰에서는 못 한다.** 새 프로젝트를 열 때마다 SSH 가 필요하다는 뜻이고, 프로젝트를 여럿 굴리는
구성(→ [room-personas.md](room-personas.md))에서는 이게 매번 걸린다.

봇은 이미 모르는 방에 초대되면 그 방의 `chatId` 를 알려준다(`greetUnknownRoom`, bot.mjs:1648).
알려주기까지 하고 **정작 넣는 건 사람이 SSH 로** 하는 게 지금 상태다. 그 반 발짝을 잇는다.

## 결정

### 봇은 `config.json` 을 쓰지 않는다

"어드민 방을 정하고 그 방에서 config 를 고친다"를 먼저 검토했고, **기각했다.** 이유는 두 파일의
실패 방식이 비대칭이라는 데 있다.

| 파일 | 깨졌을 때 |
|---|---|
| `state.json` | `loadState()` 가 파싱 실패 시 `{}` 로 폴백한다(bot.mjs:1300~1308). 봇은 산다 |
| `config.json` | 부팅 `JSON.parse`(bot.mjs:152)에 보호가 없다. 즉사 → launchd 재시작 → 또 즉사 = **크래시 루프.** 복구 수단은 SSH 뿐 |

쓰기는 원자적이지 않다(`saveState` 는 단순 `writeFileSync`, bot.mjs:1309). 즉 **원격 관리를 하려고
만든 기능이 실패하는 순간 SSH 를 유일한 복구 수단으로 만든다.** 없느니만 못하다.

두 번째 이유는 소유권이다. `config.json` 은 손편집 파일이고 주석·키 순서에 사람의 의도가 실려
있다. 봇이 `JSON.stringify` 로 재직렬화하면 매번 뭉개지고, 에디터에 열어 둔 채 봇이 쓰면 나중에
저장하는 쪽이 조용히 이긴다. **config 는 사람 것, state 는 봇 것** — 이 규칙은 이미 코드에
명문화돼 있다(bot.mjs:1326 주석: "config.json 은 봇이 고칠 수 없으니 state 에 남겨서").

### 안전하게 원격 편집할 수 있는 키는 사실상 없다

"위험한 키만 빼고 열자"도 검토했다. 남는 게 없다.

| 키 | 편집 권한이 주는 것 |
|---|---|
| `commands` | `shell: true` 로 원문 실행. `permissionMode` 도 `codexSandbox` 도 안 거친다 = 임의 셸 |
| `env` | claude·codex·커스텀 명령 전부에 주입. `PATH`·`NODE_OPTIONS` 로 임의 코드 |
| `claudeBin`·`codexBin`·`ollamaBin` | 실행할 바이너리 자체 |
| `projectDir` | 모든 실행의 cwd. `acceptEdits` 와 합치면 편집 범위가 통째로 이동한다 |
| `permissionMode`·`codexSandbox` | **권한 상한을 스스로 올린다** |
| `schedule` | 사람이 안 보는 시간에 도는 프롬프트. 위와 결합하면 지연 실행 |
| `token` | 읽기만 돼도 사고 |
| `allowedChatId` | 그 방 전원에게 머신 접근권 (README 위협 모델) |

남는 안전한 키(`lang`·`name`·`mergeWindowMs`·`autoCompactThreshold`)는 **쓸모 있는 것들이 이미
state 로 런타임 변경된다** — `/mergewindow`·`/autocompact`·`/ollama`. 즉 config 쓰기가 추가로
주는 것은 위험한 키뿐이다.

### 어드민은 방이 아니라 사람이다

"`allowedChatId` 의 첫 항목을 어드민 방으로"도 기각했다.

- **순서에 의미가 없다.** `allowedIds` 는 문자열/배열을 평탄화한 것뿐이다(bot.mjs:232~235).
  첫 항목이 그룹이면 **그 그룹 전원이 어드민**이 된다. 그룹 관리자가 사람을 추가하는 순간 늘어난다.
- **마이그레이션이 순서를 흔든다.** 그룹→슈퍼그룹 승격 시 새 ID 는 `state.adoptedChatIds` 로 가고
  (bot.mjs:4419~4420) config 의 옛 ID 는 죽은 값으로 남는다. 첫 항목이 승격되면 어드민이 아무도
  없는 chatId 를 가리킨다.
- **포럼 토픽을 표현할 수 없다.** 방 키는 `chatId:threadId` 까지 가는데(bot.mjs:1339)
  `allowedChatId` 에는 그룹 ID 만 있다. `baseChatId` 로 검사하면 그 포럼의 **모든 토픽**이
  어드민이 된다.

권한 경계가 배열 순서에 실리면 안 된다. 대신 **사람(user id)** 으로 가른다 — 코드에 이미 그 규칙이
있다:

```js
const isOwner = allowedIds.includes(String(from?.id));   // bot.mjs:1654
```

"내 DM 의 chatId = 내 텔레그램 user id" 라는 성질을 이용한 것으로, 지금도 config 경로를 노출할지
말지를 이 규칙으로 가른다. 그룹에서 명령을 쳐도 `msg.from.id` 로 검사되므로 **그룹 멤버십이
권한이 되지 않는다.** 새 config 키(`adminChatId`)도, 묵시적 "첫 항목" 규칙도 만들지 않는다.

### `/allow` — 화이트리스트만 여는 명령 하나

범용 `/config set` 을 만들지 않는다. 용도별 명령 하나만 판다.

| 입력 | 동작 |
|---|---|
| `/allow` | 현재 화이트리스트 나열. 출처를 `[config]` / `[state]` 로 표시 (cron 목록의 관례 그대로, bot.mjs:2556) |
| `/allow <chatId>` | `state.adoptedChatIds` 에 추가하고 `allowedIds.push` 로 **즉시 발효.** 재시작 불필요 — 승격 채택(bot.mjs:4419~4420)이 이미 쓰는 경로다 |
| `/allow rm <chatId>` | **state 출신만** 제거. config 출신이면 "config.json 에서 지우고 `/restart`" 라고 정직하게 안내한다 |

- 게이트는 `msg.from.id`. 오너가 아니면 명령 자체를 모르는 척한다(존재를 알리지 않는다).
- 흐름이 자연스럽게 닫힌다: 새 그룹에 초대 → 봇이 `chatId` 안내(bot.mjs:1648) → 오너가 DM 에서
  `/allow <그 값>`.
- ~~`state.adoptedChatIds` 를 그대로 재사용한다.~~ — **구현에서 새 키로 정했다.**
  `state.allowedChatIds` 를 따로 두고 부팅 병합에 한 줄 더한다. 재사용하면 이름이 거짓말을 한다 —
  "승격으로 물려받았다"는 말에 수동 추가가 섞이면, 나중에 `adoptedChatIds` 를 특별 취급하는 코드가
  전부 어긋난다. 갈라 두면 목록도 `[config]`·`[added]`·`[adopted]` 세 갈래로 정직하게 보인다.

### 에이전트는 이 경로를 못 부른다

`/allow` 는 `bot.mjs` 가 직접 파싱하는 명령이어야 한다. 에이전트(claude/codex)가 화이트리스트를
늘릴 수 있으면 **프롬프트 주입이 권한 부여에 닿는다** — 붙여넣은 로그나 읽은 문서 안의 지시가
방을 여는 경로가 된다. 마커(`[[ctb-…]]`) 계열로도 열지 않는다.

## 안 하기로 한 것

- **봇의 `config.json` 쓰기 일체.** 크래시 루프 · 소유권 충돌 · 키 단위로 권한을 가를 수 없음.
- **범용 `/config set <키> <값>`.** 지금 안전한 키만 열어도, 이후 config 에 키가 추가될 때마다
  "이건 원격 설정 가능해도 되나"를 심사해야 하는 표면이 남는다.
- **`/config get` 류의 config 원문 노출.** 토큰이 채팅 스크롤백에 남는 경로를 만들지 않는다.
  부팅 로그조차 토큰을 가린다(bot.mjs:158). 작업 폴더·권한 모드는 `/status` 가 이미 보여준다.
- **`token`·`commands`·`env`·`*Bin`·`projectDir`·`permissionMode`·`codexSandbox`·`schedule` 의
  원격 편집.** 전부 자격증명이거나 권한 상한이다.
- **어드민 "방"** — 위 "어드민은 방이 아니라 사람이다".

## 구현 자리

| 자리 | 지금 |
|---|---|
| 화이트리스트 조립 | bot.mjs:232~235 + 1328 (state 병합) |
| 런타임 추가 선례 | `adoptMigratedChat` bot.mjs:4419~4420 |
| 오너 판정 | bot.mjs:1654 (`isOwner`) — 함수로 빼서 공용화 |
| 모르는 방 안내 | `greetUnknownRoom` bot.mjs:1648 — 안내 문구에 `/allow` 언급 추가 |
| 안내 문구 | `helpText` 영/한 · `setMyCommands` 영/한 · `roomNotAllowed` 영/한 |
| README | 명령어 표 두 벌 + Security 절 |

**Security 절에 반드시 적을 것:** `/allow` 로 추가한 방도 config 에 적은 방과 권한이 완전히
같다. 그룹이면 그 그룹 전원이다.

## 단계

| 단계 | 내용 |
|---|---|
| ~~1~~ | ~~`isOwner` 공용화 + `/allow` 나열·추가·제거 · 안내 문구 6자리 · README 두 벌~~ — **0.5.0 에서 했다** |
| ~~2~~ | ~~`greetUnknownRoom` 안내에 `/allow` 흐름 연결~~ — **0.5.0 에서 1 과 같이 했다** (문구 한 줄이라 떼어 둘 값이 없었다. 오너에게만 `/allow <id>` 를 보여준다) |

**구현에서 더 막은 것 하나.** 오너가 아니면 거절 문구도 보내지 않고 **에이전트에게 넘기지도
않는다.** 처음엔 "모르는 척 = 평범한 미지의 명령처럼 통과"로 생각했는데, 통과시키면 그 문자열이
그대로 프롬프트가 되어 `bypassPermissions` 에서 에이전트가 config 를 고칠 수 있다 — 이 문서가
막으려던 바로 그 경로다. 그래서 조용히 버리고 콘솔에만 남긴다.

페르소나를 채팅에서 만드는 흐름(→ [room-personas.md](room-personas.md) 8단계)이 같은 게이트를
쓴다. 이 문서의 1단계가 그쪽의 선행 조건이다.

## 열린 질문

- ~~**`state.adoptedChatIds` 재사용 vs 새 키.**~~ — **새 키(`state.allowedChatIds`)로 정했다.**
  위 "`/allow`" 절 참고. 목록이 세 출처를 그대로 보여주는 값이 실제로 있었다.
- **오너가 여럿인 구성.** 지금 규칙은 "DM 이 화이트리스트에 있는 사람"이라 DM 을 여러 개 넣으면
  전원이 오너다. 별도 `owners` 개념이 필요한지는 실제로 그런 구성이 생길 때 판단한다.
