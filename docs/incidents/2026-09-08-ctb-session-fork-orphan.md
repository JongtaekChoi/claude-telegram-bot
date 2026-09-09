# 2026-09-08 — `ctb` 터미널 세션이 `/clear` 이후 방과 끊긴다 (조용한 유실)

> 상태: **미수정**. 이번 건은 `state.json` 을 손으로 고쳐 응급 복구했다. 코드 수정은 아래 「제안하는 수정」.

## 증상

`ctb --chat <방>` 으로 방 세션을 터미널에 이어받아 작업하다 **`/clear` 를 하면**, 그 이후의 대화가
`.claude-bot/state.json` 의 방 `sessionId` 와 분리된다. 터미널에는 아무 경고도 없다.

이후 텔레그램에서 같은 방에 말을 걸면 봇은 **갈라지기 전** 세션을 이어받는다. 오너 눈에는
"방금 터미널에서 한 얘기를 봇이 통째로 모른다" 로 보인다. 에러도, 로그도 없다.

## 이번 사례 (2026-09-08, cube-brain-trainer)

| | |
|---|---|
| 방 | `-1003316591811:72` — 큐브기획방 / 마케팅, persona `planner` |
| `state.json` 이 가리키던 세션 | `875b144a-be48-49f7-9370-87535caf4600` |
| `/clear` 이후 실제 세션 | `ea0b1331-d021-47c4-9527-ac49866ab64b` |

터미널에서 "이 세션이 어떤 세션인가" 를 묻다가 발견했다. 프로세스 인자(`--resume 875b144a…`)와
스크래치패드 경로(`…/ea0b1331…/scratchpad`)의 UUID 가 서로 달라서 드러났다 — **묻지 않았으면
몰랐을 종류의 어긋남이다.**

## 재현

1. `ctb --chat <방>` — `state.json` 의 방 `sessionId` 로 `claude --resume` 실행
2. 터미널에서 `/clear`
3. `~/.claude/projects/<cwd-slug>/` 에 **새 sessionId 의 jsonl** 이 생긴다
4. `state.json` 의 그 방 `sessionId` 는 **여전히 옛 id**

## 근본 원인

`ctb` 의 터미널 경로에 **세션 id 되쓰기가 없다.**

```
ctb.mjs:450   const sessionId = room?.[sessionKey] || st[sessionKey]   // 시작할 때 한 번 읽고
ctb.mjs:500   finalArgs = [...(sessionId ? ["--resume", sessionId] : []), ...]
ctb.mjs:510   child.on("close", …) → notifyTelegram(configPath, provider, sessionId, primaryChatId)
                                                                ^^^^^^^^^ 처음 읽은 그 값
```

대화형 실행은 `stdio: "inherit"` 라 자식이 끝난 뒤 **실제 세션 id 를 회수할 경로가 없다.**
`/clear` 로 세션이 갈라져도 `ctb` 는 그 사실 자체를 모른다.

텔레그램 경로에는 이 되쓰기가 있다 — `bot.mjs` 가 매 실행마다 `commitSid(…, res.sessionId, …)` 로
갱신한다(`--output-format json` 이라 새 id 가 결과에 딸려온다). 호출은 네 곳이다:
`bot.mjs:4138`(일반 실행) · `4785`(작업) · `4709`(plan) · `4504`(codex 폴백).
**터미널 경로만 비어 있다.**

> 이 문단은 처음에 `session.mjs:114-117` 을 근거로 들었으나 **틀렸다.** 그 파일은
> `import { createSession } from 'claude-telegram-bot/session.mjs'` 로 쓰는 **외부용 라이브러리**로,
> `package.json` 의 exports 로만 노출돼 있고 `bot.mjs`·`ctb.mjs` 어느 쪽도 쓰지 않는다.
> 거기에도 같은 되쓰기가 있는 건 사실이지만 봇이 실제로 도는 코드가 아니다. 결론은 바뀌지 않는다.

Claude Code 쪽은 정상이다. `/clear` 가 새 세션을 만드는 건 문서된 동작이다. 그걸 따라가지
못하는 게 `ctb` 다.

## 왜 조용히 어긋나는가

- 갈라진 세션도 **정상 동작한다** — 터미널 쪽은 아무 이상이 없다.
- 텔레그램 쪽도 **정상 동작한다** — 옛 세션이 멀쩡히 답한다.
- 어긋난 건 **둘이 같은 대화라는 가정**뿐이라, 양쪽 어디에도 증상이 안 뜬다.
  기존 사례(`2026-07-03-plan-send-silent-failure.md`)와 같은 계열이다 — 로그가 조용한 게
  무죄의 근거가 아니다.

## 고칠 근거: `bridgeSessionId`

갈라진 두 transcript 의 첫머리를 비교했더니 **같은 `bridgeSessionId` 가 박혀 있었다.**

```jsonc
// 875b144a-….jsonl
{"type":"bridge-session","sessionId":"875b144a-…","bridgeSessionId":"cse_0174iJ8sj15sWPbtZw3Hcs1Z", …}
// ea0b1331-….jsonl  ← /clear 이후
{"type":"bridge-session","sessionId":"ea0b1331-…","bridgeSessionId":"cse_0174iJ8sj15sWPbtZw3Hcs1Z", …}
```

같은 CLI 프로세스에서 갈라진 세션을 묶는 **정확한 키**다. mtime 최신값 추정보다 안전하다
(같은 프로젝트에서 `ctb` 터미널 여러 개가 동시에 도는 게 이 저장소에선 흔하다).

## 제안하는 수정

`child.on("close")` 시점에 **실제로 끝난 세션 id** 를 알아내 `state.json` 의 방 항목을 갱신한다.

1. 시작할 때 `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` 에서 `bridgeSessionId` 를 읽어둔다.
2. 종료 후 같은 디렉터리에서 **시작 시각 이후 생성**되고 **같은 `bridgeSessionId`** 를 가진
   가장 최신 jsonl 을 찾는다.
3. 그 id 가 시작 id 와 다르면 `state.sessions[chatId].sessionId` 를 갱신하고,
   `sessionPersona` 에도 새 id → 같은 persona 를 넣는다.
   (⚠️ **읽고-고치고-쓰기** 로. 봇 데몬이 `state` 를 메모리에 들고 있어 통째로 덮으면 안 된다 — 아래 함정.)
4. `notifyTelegram` 에도 옛 id 가 아니라 **갱신된 id** 를 넘긴다.
5. stderr 에 한 줄 남긴다 — 예: `session forked: 875b144a… → ea0b1331…, 방 -1003…:72 갱신`.

**폴백**(`bridgeSessionId` 가 없는 환경 — 비로그인/구버전): 같은 cwd + 시작 시각 이후 mtime 중
최신 jsonl. **확신이 없으면 갱신하지 말고 경고만 찍는다.** 조용히 틀린 방에 붙이는 게 최악이다.

### 함정: 봇 데몬이 `state` 를 메모리에 들고 있다

`bot.mjs:1500` 이 `let state = loadState()` 로 **기동 시 한 번만** 읽고, `saveState(state)` 는
메모리 객체를 **통째로 덮어쓴다**. 그래서

- `ctb` 가 종료하면서 `state.json` 을 고쳐도, 실행 중인 봇이 다음 저장을 하는 순간 **되돌아간다.**
- 손으로 고쳤을 때도 같다 — 이번 응급조치가 그래서 **봇 재시작이 필요했다.**

즉 이 수정은 파일만 고쳐선 안 되고, 다음 중 하나가 같이 필요하다:

- (a) 봇이 `state.json` 을 **변경 감지해 다시 읽기**(파일 watch 또는 저장 직전 머지), 또는
- (b) `ctb` 가 실행 중인 봇에게 갱신을 **알려** 메모리 쪽을 고치게 하기(`ctb send` 가 쓰는 통로 재사용), 또는
- (c) 최소한 **재시작이 필요하다고 stderr 에 명시**.

(a) 가 근본이다 — 이 클로버 문제는 세션 id 말고 다른 필드에서도 언제든 다시 난다.

## 검토 필요

- **자동 갱신이 맞나?** 오너가 완전히 다른 일을 하려고 `/clear` 했을 수도 있다. 그래도 "터미널은
  그 방의 세션" 이라는 게 `ctb` 의 전제라 자동이 맞다고 본다. 대안은 종료 시 한 줄 물어보기.
- **동시 실행 오탐**: 같은 프로젝트에서 `ctb` 터미널 여러 개 + 텔레그램 세션들이 함께 돈다.
  `bridgeSessionId` + 시작 시각으로 충분한지 실봇으로 확인 필요.
- **`/clear` 말고 다른 갈라짐**: 압축(compact)·재개 실패 후 새 세션 등에서도 같은 일이 나는지.

## 이번 건 응급조치

`.claude-bot/state.json` 을 손으로 고쳤다(백업 뜬 뒤 JSON 파싱 검증).

```
sessions["-1003316591811:72"].sessionId : 875b144a-… → ea0b1331-…
sessionPersona["ea0b1331-…"] = "planner"   (추가)
```

**봇 재시작 전까지는 메모리 쪽이 옛 값이라 반영되지 않는다** — 위 함정 그대로다.

## 교훈

- **되쓰기가 한쪽 경로에만 있으면 언젠가 갈라진다.** 텔레그램 경로에는 `commitSid` 가 갱신을
  하고 있었고, 터미널 경로는 같은 상태를 읽기만 했다. 상태를 공유하는 두 입구는 **읽기·쓰기 대칭**이어야 한다.
- **"프로세스 인자와 실제 상태가 다를 수 있다"** — `ps` 에 보이는 `--resume <id>` 는 기동 당시의
  사실일 뿐 현재의 사실이 아니다. 세션 정체를 확인할 땐 transcript 파일까지 봐야 한다.
- 조용한 유실은 **묻지 않으면 안 드러난다.** 이번에도 오너가 "이 세션이 어떤 세션인가" 를
  물어서 나왔다. 어긋남을 자동으로 알려주는 한 줄(stderr 경고)이 그래서 수정의 일부다.
