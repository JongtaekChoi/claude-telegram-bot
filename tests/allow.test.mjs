// /allow — 오너 DM 어드민. 화이트리스트를 폰에서 늘리고 줄인다.
// 되돌릴 수 없는 실수를 막는 게 이 명령의 절반이다: config 출신은 지웠다고 말해놓고 재시작하면
// 되살아나고, 본인 DM 을 빼면 /allow 자체에 못 닿는다. 둘 다 폰에서는 복구할 방법이 없다.
// → docs/design/owner-admin.md
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const CHAT_ID_RE =", "function cronListText");

let sent, saved, logged;

function build({ config = ["688"], added = [], adopted = [], from = { id: 688 } } = {}) {
  sent = []; saved = 0; logged = [];
  const state = { allowedChatIds: [...added], adoptedChatIds: [...adopted] };
  const allowedIds = [...config, ...added, ...adopted];
  const api = new Function(
    "CONFIG_ALLOWED", "state", "allowedIds", "send", "t", "saveState", "console", "CONFIG_PATH",
    `${block}\nreturn { handleAllow, allowSource, CHAT_ID_RE };`,
  )(
    config, state, allowedIds,
    async (id, text) => { sent.push({ id, text }); },
    (l, k, ...a) => `${k}(${a.join("|")})`,
    () => { saved++; },
    { log: (m) => logged.push(m), warn: (m) => logged.push(m), error() {} },
    "/etc/bot/config.json",
  );
  return { ...api, state, allowedIds, from };
}

// ── 출처 세 갈래 ─────────────────────────────────────────────────────────
{
  const a = build({ config: ["688"], added: ["-100"], adopted: ["-200"] });
  ok("출처: config", a.allowSource("688") === "config");
  ok("출처: added", a.allowSource("-100") === "added");
  ok("출처: adopted", a.allowSource("-200") === "adopted");
  ok("출처: 모르는 id 는 null", a.allowSource("-999") === null);
}
{
  const a = build({ config: ["688"], added: ["-100"], adopted: ["-200"] });
  await a.handleAllow("688", "", "ko", a.from, "688");
  ok("목록: 1건", sent.length === 1);
  const body = sent[0].text;
  ok("목록: 세 갈래가 다 뜬다",
    body.includes("[config] 688") && body.includes("[added] -100") && body.includes("[adopted] -200"), body);
}

// ── 추가 ─────────────────────────────────────────────────────────────────
{
  const a = build();
  await a.handleAllow("688", "-1003316591811", "ko", a.from, "688");
  ok("추가: state 에 들어간다", a.state.allowedChatIds.includes("-1003316591811"),
     JSON.stringify(a.state.allowedChatIds));
  ok("추가: 재시작 없이 즉시 발효", a.allowedIds.includes("-1003316591811"),
     JSON.stringify(a.allowedIds));
  ok("추가: 저장한다", saved === 1);
  ok("추가: 확인 문구", sent[0].text.startsWith("allowAdded("), sent[0].text);
  ok("추가: 로그를 남긴다", logged.some((m) => String(m).includes("Allowed chat added")), JSON.stringify(logged));
}
{
  const a = build({ added: ["-100"] });
  await a.handleAllow("688", "-100", "ko", a.from, "688");
  ok("추가: 이미 있으면 출처를 대며 거절", sent[0].text === "allowAlready(-100|added)", sent[0].text);
  ok("추가: 중복 저장 안 함", saved === 0);
  ok("추가: 중복 push 안 함", a.allowedIds.filter((x) => x === "-100").length === 1);
}
{
  const a = build();
  await a.handleAllow("688", "@channel", "ko", a.from, "688");
  ok("추가: 숫자 아닌 id 거절", sent[0].text.startsWith("allowBadId("), sent[0].text);
  ok("추가: 거절 시 저장 안 함", saved === 0);
}
{
  ok("id 형식: 음수 그룹 허용", build().CHAT_ID_RE.test("-1003316591811"));
  ok("id 형식: 양수 DM 허용", build().CHAT_ID_RE.test("688344084"));
  ok("id 형식: 토픽 접미사는 거절", !build().CHAT_ID_RE.test("-100:35"));
  ok("id 형식: 빈 문자열 거절", !build().CHAT_ID_RE.test(""));
}

// ── 제거 — 되돌릴 수 없는 것을 막는다 ────────────────────────────────────
{
  const a = build({ config: ["688", "-100"] });
  await a.handleAllow("688", "rm -100", "ko", a.from, "688");
  ok("제거: config 출신은 막는다", sent[0].text.startsWith("allowRmConfig("), sent[0].text);
  ok("제거: config 출신은 목록에 남는다", a.allowedIds.includes("-100"));
  ok("제거: 막았으면 저장 안 함", saved === 0);
  ok("제거: 안내에 config 경로를 준다", sent[0].text.includes("/etc/bot/config.json"), sent[0].text);
}
{
  const a = build({ config: [], added: ["688"], from: { id: 688 } });
  await a.handleAllow("688", "rm 688", "ko", a.from, "688");
  ok("제거: 본인 DM 은 막는다", sent[0].text === "allowRmSelf()", sent[0].text);
  ok("제거: 본인 DM 은 목록에 남는다", a.allowedIds.includes("688"));
  ok("제거: 막았으면 저장 안 함", saved === 0);
}
{
  const a = build({ added: ["-100"] });
  await a.handleAllow("688", "rm -100", "ko", a.from, "688");
  ok("제거: added 는 지워진다", !a.state.allowedChatIds.includes("-100"));
  ok("제거: 즉시 발효 (allowedIds 에서도 빠진다)", !a.allowedIds.includes("-100"));
  ok("제거: 저장한다", saved === 1);
  ok("제거: 확인 문구", sent[0].text.startsWith("allowRmDone("), sent[0].text);
}
{
  const a = build({ adopted: ["-200"] });
  await a.handleAllow("688", "rm -200", "ko", a.from, "688");
  ok("제거: adopted 는 adoptedChatIds 에서 빠진다", !a.state.adoptedChatIds.includes("-200"),
     JSON.stringify(a.state.adoptedChatIds));
  ok("제거: adopted 지울 때 allowedChatIds 는 안 건드린다",
     Array.isArray(a.state.allowedChatIds) && a.state.allowedChatIds.length === 0);
}
{
  const a = build();
  await a.handleAllow("688", "rm -999", "ko", a.from, "688");
  ok("제거: 없는 id 는 안내만", sent[0].text.startsWith("allowRmNotFound("), sent[0].text);
  ok("제거: 없는 id 는 저장 안 함", saved === 0);
}
{
  // 지운 게 지금 이 방이면 답장이 마지막이라는 걸 문구가 알려야 한다
  const a = build({ added: ["-100"] });
  await a.handleAllow("-100", "rm -100", "ko", { id: 688 }, "-100");
  ok("제거: 이 방을 지우면 문구가 그걸 밝힌다", sent[0].text === "allowRmDone(-100|true)", sent[0].text);
}
{
  const a = build({ added: ["-100"] });
  await a.handleAllow("688", "rm -100", "ko", { id: 688 }, "688");
  ok("제거: 다른 방을 지우면 false", sent[0].text === "allowRmDone(-100|false)", sent[0].text);
}
{
  const a = build();
  await a.handleAllow("688", "rm", "ko", a.from, "688");
  ok("제거: id 없이 rm 만 → 사용법", sent[0].text === "allowUsage()", sent[0].text);
}

report();
