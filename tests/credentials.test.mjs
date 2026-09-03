// 자격증명 갈라짐 판정 + 오류 분류. 2026-09-02 에 봇 넷이 이 때문에 조용히 죽었다 —
// launchd 는 키체인을, 터미널은 파일을 읽어서 터미널 테스트는 계속 통과했다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const credBlock = cut("const CRED_FILE =", "// 오류 분류.");
const clsBlock = cut("function classifyClaudeError", "\n// ── 커스텀 명령어");

const NOW = 1_800_000_000_000;
const cred = (tok, exp) => JSON.stringify({ claudeAiOauth: { accessToken: "tok" + tok, expiresAt: exp } });

function build({ file = null, keychain = null, sessions = {}, provider = "claude", allowed = ["1"] } = {}) {
  const sent = [];
  const api = new Function(
    "join", "readFileSync", "execFileSync", "process", "t", "BOT_LANG", "send", "allowedIds",
    "state", "currentProvider", "console", "Date",
    credBlock + clsBlock + "\nreturn { credStatus, checkCredentials, classifyClaudeError };",
  )(
    (...p) => p.join("/"),
    () => { if (file === null) throw new Error("ENOENT"); return file; },
    () => { if (keychain === null) throw new Error("no item"); return keychain; },
    { platform: "darwin", env: { HOME: "/home" } },
    (l, k, ...a) => `${k}(${a.map((v) => String(v).slice(0, 20)).join("|")})`,
    "ko",
    async (id, m) => { sent.push({ id, m }); },
    allowed,
    { sessions },
    () => provider,
    { log() {}, warn() {}, error() {} },
    { now: () => NOW },
  );
  return { ...api, sent };
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
  ok("split → 오너 방으로 1건", b.sent.length === 1 && b.sent[0].id === "1", JSON.stringify(b.sent));
  ok("split 문구 사용", b.sent[0]?.m === "credSplit()", b.sent[0]?.m);
  await b.checkCredentials();
  ok("같은 상태 반복 → 도배 안 함", b.sent.length === 1, String(b.sent.length));
}
{
  const b = build({ file: cred(1, NOW - 1) });
  await b.checkCredentials();
  ok("expired 문구에 저장소 표시", b.sent[0]?.m === "credExpired(file)", b.sent[0]?.m);
}
{
  const b = build();
  await b.checkCredentials();
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

report();
