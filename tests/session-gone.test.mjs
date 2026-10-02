// state.json 의 세션이 사라졌는데 봇이 항상 --resume 을 붙여서, 그 방이 영영 아무것도 못 돌리던
// 자리(2026-10-02). 구현 토픽이 그렇게 잠겼고, 터미널에서 `ctb send` 로 그 방에 말을 거는 길까지
// 같이 막혀 **고치러 가는 길 자체가 끊겼다.** 탈출구가 state.json 손편집뿐이었다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

// 판정식만 떼어 쓴다 — 실제 소스의 정규식이 바뀌면 같이 바뀌어야 한다.
const detector = cut("const SESSION_GONE_RE =", "\nfunction isFallbackError");
const isSessionGone = new Function(`${detector}\nreturn isSessionGone;`)();

// 실제로 본 문구
ok("claude CLI 의 문구를 잡는다",
   isSessionGone("No conversation found with session ID: 54aaf2c3-0e1b-4d2a-9f77-2b1c8e9a0d41"));
ok("codex 쪽 문구도 잡는다", isSessionGone("Error: thread not found"));
ok("대소문자를 가리지 않는다", isSessionGone("no conversation found with session id: x"));

// 멀쩡한 실패를 세션 문제로 오인하면 맥락을 멋대로 버린다 — 이쪽이 더 위험하다
ok("한도 초과는 아니다", !isSessionGone("Claude usage limit reached. Resets at 3pm"));
ok("인증 실패는 아니다", !isSessionGone("Failed to authenticate. Please run /login"));
ok("빈 출력은 아니다", !isSessionGone("") && !isSessionGone(undefined));
ok("파일 못 찾음은 아니다", !isSessionGone("ENOENT: no such file or directory"));

// 재시도가 실제로 ID 를 버리고 한 번만 도는지. runClaude 를 통째로 떼기엔 spawn 이 걸려서,
// 분기 모양만 같은 자리를 세운다 — 조건식 자체는 위에서 소스로 검증했다.
let calls = [];
// 죽은 ID 로 부르면 provider 가 거절하고, ID 없이 부르면 새 세션이 열려 성공한다 — 실제 모양이다.
async function runOnce(sessionId, raw, freshRetry = false) {
  calls.push(sessionId);
  const failed = Boolean(sessionId) && isSessionGone(raw);
  if (sessionId && !freshRetry && failed)
    return { ...(await runOnce(undefined, raw, true)), sessionRestarted: true };
  return { ok: !failed, text: failed ? raw : "answer" };
}

calls = [];
let res = await runOnce("dead-sid", "No conversation found with session ID: dead-sid");
ok("죽은 세션이면 ID 없이 한 번 더 돈다", calls.length === 2 && calls[1] === undefined, JSON.stringify(calls));
ok("새로 시작했다고 알린다", res.sessionRestarted === true && res.ok, JSON.stringify(res));

calls = [];
res = await runOnce("live-sid", "");
ok("멀쩡하면 다시 돌지 않는다", calls.length === 1 && !res.sessionRestarted, JSON.stringify(calls));

calls = [];
res = await runOnce(undefined, "No conversation found with session ID: x");
ok("애초에 세션이 없었으면 재시도하지 않는다 (무한루프 방지)", calls.length === 1, JSON.stringify(calls));

report("session-gone");
