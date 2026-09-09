// 자격증명 갈라짐 판정 + 오류 분류. 2026-09-02 에 봇 넷이 이 때문에 조용히 죽었다 —
// launchd 는 키체인을, 터미널은 파일을 읽어서 터미널 테스트는 계속 통과했다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const credBlock = cut("const CRED_FILE =", "// 오류 분류.");
const clsBlock = cut("function classifyClaudeError", "\n// ── 커스텀 명령어");

const NOW = 1_800_000_000_000;
const cred = (tok, exp) => JSON.stringify({ claudeAiOauth: { accessToken: "tok" + tok, expiresAt: exp } });

// 키체인 접근은 두 걸음이다: 존재 확인(-w 없이) → 값 읽기(-w).
// unreadable 은 "항목은 있는데 값은 못 읽는다" — 잠긴 키체인에서 실제로 나는 상태다.
function build({
  file = null, keychain = null, unreadable = false,
  sessions = {}, provider = "claude", allowed = ["1"], platform = "darwin",
} = {}) {
  const sent = [];
  const timers = [];
  const api = new Function(
    "join", "readFileSync", "execFileSync", "process", "t", "BOT_LANG", "send", "allowedIds",
    "state", "currentProvider", "console", "Date", "setTimeout", "clearTimeout",
    credBlock + clsBlock + "\nreturn { credStatus, checkCredentials, classifyClaudeError };",
  )(
    (...p) => p.join("/"),
    () => { if (file === null) throw new Error("ENOENT"); return file; },
    (bin, args) => {
      const present = keychain !== null || unreadable;
      if (!args.includes("-w")) {                    // 존재 확인
        if (!present) throw new Error("SecKeychainSearchCopyNext: not found");
        return "";
      }
      if (unreadable) throw new Error("User interaction is not allowed.");  // rc=36
      if (keychain === null) throw new Error("not found");
      return keychain;
    },
    { platform, env: { HOME: "/home" } },
    (l, k, ...a) => `${k}(${a.map((v) => String(v).slice(0, 20)).join("|")})`,
    "ko",
    async (id, m) => { sent.push({ id, m }); },
    allowed,
    { sessions },
    () => provider,
    { log() {}, warn() {}, error() {} },
    { now: () => NOW },
    (fn) => { timers.push(fn); return { unref() {} }; },
    () => {},
  );
  // 확인 단계를 사람 대신 돌려준다 — 실제로는 60초 뒤에 스스로 다시 본다.
  const settle = async () => { while (timers.length) await timers.shift()(); };
  return { ...api, sent, timers, settle };
}

// ── credStatus ───────────────────────────────────────────────────────────
ok("둘 다 없음 → none", build().credStatus().why === "none");
ok("파일만, 유효 → 정상", build({ file: cred(1, NOW + 1000) }).credStatus().why === null);
{
  const s = build({ file: cred(1, NOW - 1) }).credStatus();
  ok("파일만, 만료 → expired/file", s.why === "expired" && s.store === "file");
}
{
  const s = build({ keychain: cred(1, NOW - 1) }).credStatus();
  ok("키체인만, 만료 → expired/keychain", s.why === "expired" && s.store === "keychain");
}
ok("둘 다 있고 토큰 같음 → 정상",
   build({ file: cred(1, NOW + 1), keychain: cred(1, NOW + 1) }).credStatus().why === null);
ok("★ 토큰 갈라짐 → split (아직 유효해도 다음 회전에 깨진다)",
   build({ file: cred(2, NOW + 99999), keychain: cred(1, NOW + 99999) }).credStatus().why === "split");
ok("★ 갈라짐 + 만료 → split 우선 (고치는 법이 다르다)",
   build({ file: cred(2, NOW + 99999), keychain: cred(1, NOW - 1) }).credStatus().why === "split");
ok("키체인이 읽히면 그쪽이 판정 대상",
   build({ file: cred(1, NOW + 9), keychain: cred(1, NOW - 1) }).credStatus().store === "keychain");
ok("깨진 JSON → 없는 것으로", build({ file: "{{{" }).credStatus().why === "none");
ok("claudeAiOauth 없이 평면 객체도 읽는다",
   build({ file: JSON.stringify({ accessToken: "a", expiresAt: NOW + 5 }) }).credStatus().why === null);

// ── checkCredentials ─────────────────────────────────────────────────────
{
  const b = build({ file: cred(2, NOW + 9), keychain: cred(1, NOW + 9) });
  await b.checkCredentials();
  await b.settle();
  ok("split → 오너 방으로 1건", b.sent.length === 1 && b.sent[0].id === "1", JSON.stringify(b.sent));
  ok("split 문구 사용", b.sent[0]?.m === "credSplit()", b.sent[0]?.m);
  await b.checkCredentials();
  ok("같은 상태 반복 → 도배 안 함", b.sent.length === 1, String(b.sent.length));
}
{
  const b = build({ file: cred(1, NOW - 1) });
  await b.checkCredentials();
  await b.settle();
  ok("expired 문구에 저장소 표시", b.sent[0]?.m === "credExpired(file)", b.sent[0]?.m);
}
{
  const b = build();
  await b.checkCredentials();
  await b.settle();
  ok("자격증명 없음 → credNone", b.sent[0]?.m === "credNone()", b.sent[0]?.m);
}
{
  const b = build({ file: cred(1, NOW + 9) });
  await b.checkCredentials();
  ok("정상이면 조용하다", b.sent.length === 0, JSON.stringify(b.sent));
}
{
  const b = build({ file: cred(1, NOW - 1), provider: "codex" });
  await b.checkCredentials();
  ok("codex 전용 설정 → 확인 안 함", b.sent.length === 0);
  const c = build({ file: cred(1, NOW - 1), provider: "codex", sessions: { a: { provider: "claude" } } });
  await c.checkCredentials();
  await c.settle();
  ok("★ 기본이 codex 라도 claude 방이 있으면 확인", c.sent.length === 1);
}
{
  const b = build({ file: cred(1, NOW - 1), allowed: [] });
  await b.checkCredentials();
  ok("허용 방 없음 → 무발송", b.sent.length === 0);
}

// ── classifyClaudeError ──────────────────────────────────────────────────
{
  const c = build().classifyClaudeError;
  ok("크레딧", c("Insufficient credit balance", 1) === "errCredit()");
  ok("한도", c("rate limit exceeded", 429) === "errRateLimit()");
  ok("과부하", c("overloaded", 529) === "errOverloaded()");
  ok("컨텍스트 초과는 센티넬 문자열 유지", c("prompt is too long", 1) === "contextTooLong");
  ok("★ 인증 실패를 따로 분류",
     c("Failed to authenticate: OAuth session expired and could not be refreshed", 1).startsWith("errClaudeAuth("));
  ok("★ invalid api key 도 인증", c("invalid api key", 1).startsWith("errClaudeAuth("));
  ok("★ 그 밖의 실패는 Claude 라고 이름을 댄다", c("boom", 7) === "errClaudeFailed(7|boom)", c("boom", 7));
  ok("한도가 인증보다 먼저", c("usage limit reached", 1) === "errRateLimit()");
}

// ── 키체인에만 있음 = 터미널만 로그아웃 (2026-09-09) ─────────────────────
// 봇은 키체인을 읽어 멀쩡한데 터미널은 파일로만 폴백한다. 예전엔 이 상태를 정상으로 봐서
// 아무 말도 안 했고, "봇은 되는데 로컬은 왜 로그인이 안 되지"를 사람이 직접 캐야 했다.
{
  const s = build({ keychain: cred(1, NOW + 1000) }).credStatus();
  ok("키체인만, 유효 → keychainOnly", s.why === "keychainOnly", JSON.stringify(s));
}
{
  const s = build({ keychain: cred(1, NOW - 1) }).credStatus();
  ok("키체인만, 만료 → expired 가 우선", s.why === "expired" && s.store === "keychain", JSON.stringify(s));
}
{
  // 반대 방향은 경고하지 않는다 — 양쪽 다 그 파일을 읽으므로 성한 상태다.
  const s = build({ file: cred(1, NOW + 1000) }).credStatus();
  ok("파일만 → 경고 없음", s.why === null, JSON.stringify(s));
}
{
  const s = build({ file: cred(1, NOW + 1000), keychain: cred(1, NOW + 1000) }).credStatus();
  ok("둘 다 같은 토큰 → 경고 없음", s.why === null, JSON.stringify(s));
}
{
  const s = build({ file: cred(1, NOW + 1000), keychain: cred(2, NOW + 1000) }).credStatus();
  ok("둘 다 있고 다름 → split 이 우선", s.why === "split", JSON.stringify(s));
}
{
  const b = build({ keychain: cred(1, NOW + 1000) });
  await b.checkCredentials();
  await b.settle();
  ok("keychainOnly: 오너에게 1건", b.sent.length === 1, JSON.stringify(b.sent));
  ok("keychainOnly: 전용 문구", b.sent[0]?.m.startsWith("credKeychainOnly("), b.sent[0]?.m);
}
{
  // 상태가 안 바뀌면 도배하지 않는다
  const b = build({ keychain: cred(1, NOW + 1000) });
  await b.checkCredentials();
  await b.checkCredentials();
  ok("keychainOnly: 같은 상태는 한 번만", b.sent.length === 1, String(b.sent.length));
}

// ── 항목은 있는데 값을 못 읽는다 (2026-09-09) ────────────────────────────
// 잠긴 키체인에서는 값 읽기가 rc=36 으로 실패한다. 예전엔 이걸 "항목 없음"과 같이 다뤄서
// 같은 상태인데 판정이 계속 뒤집혔다: split → expired → split → keychainOnly → split.
// 바뀐 건 아무것도 없었고, 실제로 오탐 DM 이 나갔다.
{
  const st = build({ unreadable: true, file: cred(1, NOW + 1000) }).credStatus();
  ok("못 읽음 → unreadable (파일이 있어도)", st.why === "unreadable", JSON.stringify(st));
}
{
  const st = build({ unreadable: true }).credStatus();
  ok("못 읽음 → 파일이 없어도 none 이 아니다", st.why === "unreadable", JSON.stringify(st));
}
{
  // 예전 코드가 오탐을 내던 바로 그 조합 — 낡은 키체인 사본 + 새 파일
  const st = build({ unreadable: true, file: cred(9, NOW + 1000) }).credStatus();
  ok("못 읽음 → split 이라고 우기지 않는다", st.why !== "split", JSON.stringify(st));
}
{
  const st = build({ unreadable: true, file: cred(1, NOW - 1) }).credStatus();
  ok("못 읽음 → expired 라고도 안 한다", st.why === "unreadable", JSON.stringify(st));
}
{
  const b = build({ unreadable: true, file: cred(1, NOW + 1000) });
  await b.checkCredentials();
  await b.settle();
  ok("못 읽음 → 오너에게 아무 말 안 한다", b.sent.length === 0, JSON.stringify(b.sent));
}
{
  const st = build({ platform: "linux", file: cred(1, NOW + 1000) }).credStatus();
  ok("darwin 아니면 키체인은 없는 것으로 (unreadable 아님)", st.why === null, JSON.stringify(st));
}

// ── 흔들리는 판독으로는 안 알린다 ────────────────────────────────────────
{
  const b = build({ file: cred(2, NOW + 9), keychain: cred(1, NOW + 9) });
  await b.checkCredentials();
  ok("한 번 본 걸로는 안 알린다", b.sent.length === 0, JSON.stringify(b.sent));
  ok("대신 확인을 예약한다", b.timers.length === 1, String(b.timers.length));
  await b.settle();
  ok("두 번째도 같으면 그때 알린다", b.sent.length === 1 && b.sent[0].m === "credSplit()", JSON.stringify(b.sent));
}
{
  const stable = build({ file: cred(2, NOW + 9), keychain: cred(1, NOW + 9) });
  await stable.checkCredentials();
  await stable.settle();
  ok("안정된 판정은 정확히 1건", stable.sent.length === 1, String(stable.sent.length));
  await stable.checkCredentials();
  ok("알린 뒤 같은 상태는 조용하다", stable.sent.length === 1, String(stable.sent.length));
  ok("조용할 땐 확인도 새로 안 건다", stable.timers.length === 0, String(stable.timers.length));
}
{
  // 정상 → 정상은 확인 한 번 거친 뒤 조용하다 (부팅 직후 경로)
  const b = build({ file: cred(1, NOW + 1000) });
  await b.checkCredentials();
  await b.settle();
  ok("정상: 확인을 거쳐도 조용하다", b.sent.length === 0, JSON.stringify(b.sent));
  await b.checkCredentials();
  ok("정상: 그 뒤로도 조용하다", b.sent.length === 0);
}

report();
