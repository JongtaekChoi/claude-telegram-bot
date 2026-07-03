# 2026-07-03 — `/plan` 배포 후 봇 응답 무응답 (silent failure)

## 증상
- `main`(0.3.35, `/plan` 커맨드 추가) 배포 후, 텔레그램으로 메시지를 보내도 **가끔** 아무 응답이 없었음.
- 에러 로그(`bot.error.log`)에 크래시/예외 흔적 전혀 없음. `dispatch()`의 `Handle error` 로그도, `Polling error`도 없음.
- 이전 커밋(`cf78ef7`, 0.3.34)으로 되돌리고 `/restart` 하면 항상 정상 응답(`localBusy` 등).
- 처음엔 네트워크/VPN(Tailscale, OpenVPN) 문제나 재시작 타이밍 레이스로 오판했음 — 실제로는 순수 코드 버그였음.

## 근본 원인
`/plan` 기능 diff에서 `send()`가 아래처럼 바뀜:

```js
// Before (0.3.34) — 정상
async function send(chatId, text) {
  for (const c of chunks(text)) { ... }
}

// After (0.3.35) — 버그
async function send(chatId, text, opts = {}) {
  const cs = chunks(text);
  for (let i = 0; i < cs.length; i++) { ... }
}
```

`chunks()`는 **제너레이터 함수**(`function* chunks(...)`)라 배열이 아니고 `.length`가 없음.
`cs.length`는 `undefined` → `i < undefined`는 항상 `false` → for 루프 본문이 **한 번도 실행되지 않음**.

결과: `send()`를 호출해도 텔레그램 API 호출 자체가 발생하지 않음 → 메시지 0건 전송, 예외도 없음, 로그도 없음.
`localBusy` 답장을 포함해 **모든** `send()` 호출이 영향을 받았기 때문에, `checkLocalLock()`이 정상적으로 감지해도 답장이 통으로 사라진 것처럼 보였음.

## 발견 과정
1. `busy`/`checkLocalLock()` 분기 코드를 두 커밋 간 바이트 단위로 diff — 완전히 동일함을 확인, 이 경로는 범인이 아니라고 판단.
2. 사용자가 `test` 브랜치에서 `send()`만 0.3.34 버전으로 되돌려서 테스트 → 정상 응답 확인. 이걸로 `send()`가 범인이라고 특정.
3. `chunks`가 제너레이터라는 걸 확인하고 `cs.length` 사용이 버그라는 걸 코드 리딩으로 확정 (`node -e`로 재현 확인).

## 수정
`const cs = chunks(text)` → `const cs = [...chunks(text)]`로 제너레이터를 배열로 변환. `opts.replyMarkup`/`lastId` 등 `/plan` 기능 자체 로직은 그대로 유지.

## 교훈
- **"에러 로그가 없다" ≠ "버그가 없다".** 조건문이 항상 false가 되어 루프/분기가 통으로 스킵되는 버그는 예외를 던지지 않는다. 로그에 아무 흔적이 없다고 코드를 무죄로 판단하지 말 것.
- 제너레이터 함수(`function*`)의 반환값은 배열이 아니다. 기존에 `for...of`로만 순회하던 함수를 인덱스 기반 루프로 리팩터링할 때는 반환 타입을 먼저 확인할 것.
- 두 커밋 간 동작 차이를 조사할 때, 의심되는 함수 전체를 바이트 단위로 비교하는 걸 초반에 먼저 할 것 (구조적 grep만으로는 이런 종류의 버그를 못 잡음).
- 네트워크/타이밍/운 탓으로 돌리기 전에, 사용자가 제시한 "커밋 전환 → 재현 성공/실패"처럼 반복 가능한 상관관계는 신뢰할 것 — 반박하려면 그만큼 확실한 반례가 필요하다.
- **배포 전 실사용 테스트가 없었던 게 근본 원인.** `/plan` 기능은 실제로 텔레그램에서 메시지를 주고받아본 적 없이 커밋/배포됨. 아래 배포 규칙 참고.
