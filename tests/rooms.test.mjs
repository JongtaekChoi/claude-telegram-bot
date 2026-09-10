// /rooms — 방 목록 정리. 방은 말을 한 번 걸면 자동 등록되는데 지우는 길이 없어서
// `/newchat` 으로 만들고 버린 토픽이 쌓였다 (2026-09-10 큐브 봇에 "새 대화 08-21 19:24" 셋).
// 이 목록은 `/tell` 대상 · `/cron` 목적지 · 포럼 접수처 버튼에 전부 쓰인다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("async function handleRooms(chatId, arg, l)", "\nasync function handleTell");

let sent, saved, busy;

function build({ sessions = {}, allowed = ["-100", "688"] } = {}) {
  sent = []; saved = 0; busy = new Set();
  const state = { sessions: JSON.parse(JSON.stringify(sessions)) };
  const api = new Function(
    "state", "knownRooms", "chatRuntime", "send", "t", "saveState", "allowedIds", "baseChatId",
    `${block}\nreturn handleRooms;`,
  )(
    state,
    () => Object.entries(state.sessions || {})
      .filter(([r, b]) => b?.title && allowed.includes(String(r.split(":")[0])))
      .map(([room, b]) => ({ room, title: b.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    { get: (r) => (busy.has(String(r)) ? { busy: true } : undefined) },
    async (id, text) => { sent.push({ id, text }); },
    (l, k, ...a) => `${k}(${a.join("|")})`,
    () => { saved++; },
    allowed,
    (r) => String(r).split(":")[0],
  );
  return { handleRooms: api, state };
}

const S = {
  "688": { title: "종택 최", sessionId: "s0" },
  "-100": { title: "봇유지보수", sessionId: "s1" },
  "-100:11": { title: "봇유지보수 / 테스트", sessionId: "s2" },
  "-100:35": { title: "봇유지보수 / 새 대화 08-21", sessionId: "s3" },
  "-100:99": { title: "봇유지보수 / 새 대화 08-25", sessionId: "s4" },
};
// 제목순: 봇유지보수 / 봇유지보수 / 새 대화 08-21 / 새 대화 08-25 / 테스트 / 종택 최
const order = ["-100", "-100:35", "-100:99", "-100:11", "688"];

// ── 목록 ─────────────────────────────────────────────────────────────────
{
  const { handleRooms } = build({ sessions: S });
  await handleRooms("688", "", "ko");
  ok("목록: 1건", sent.length === 1);
  ok("목록: 개수를 같이 준다", sent[0].text.includes("|5"), sent[0].text.slice(0, 40));
  ok("목록: 번호가 붙는다", sent[0].text.includes("1. ") && sent[0].text.includes("5. "), sent[0].text);
  ok("목록: 제목순", sent[0].text.indexOf("봇유지보수\n") < sent[0].text.indexOf("종택 최"), sent[0].text);
}
{
  const { handleRooms } = build({ sessions: S });
  busy.add("-100:11");
  await handleRooms("688", "", "ko");
  ok("목록: 도는 방에 ⏳", sent[0].text.includes("테스트 ⏳"), sent[0].text);
}
{
  const { handleRooms } = build({ sessions: S });
  await handleRooms("-100:11", "", "ko");
  ok("목록: 지금 방에 ← 표시", /테스트 ←/.test(sent[0].text), sent[0].text);
}
{
  const { handleRooms } = build({ sessions: {} });
  await handleRooms("688", "", "ko");
  ok("등록된 방이 없으면 전용 문구", sent[0].text === "roomsEmpty()", sent[0].text);
}
{
  // 허용 안 된 그룹의 방은 목록에 없다
  const { handleRooms } = build({ sessions: { ...S, "-999": { title: "남의 그룹" } } });
  await handleRooms("688", "", "ko");
  ok("허용 안 된 방은 안 뜬다", !sent[0].text.includes("남의 그룹"), sent[0].text);
}

// ── 지우기 ───────────────────────────────────────────────────────────────
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "rm 2", "ko");           // 2번 = 새 대화 08-21 (-100:35)
  ok("rm: 그 방만 지운다", state.sessions["-100:35"] === undefined, JSON.stringify(Object.keys(state.sessions)));
  ok("rm: 나머지는 그대로", Object.keys(state.sessions).length === 4);
  ok("rm: 저장한다", saved === 1);
  ok("rm: 무엇을 지웠는지 이름을 댄다", sent[0].text.includes("새 대화 08-21"), sent[0].text);
}
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "rm 2 3", "ko");
  ok("rm: 여러 개 한 번에", state.sessions["-100:35"] === undefined && state.sessions["-100:99"] === undefined,
     JSON.stringify(Object.keys(state.sessions)));
  ok("rm: 개수를 알린다", sent[0].text.includes("|2"), sent[0].text);
}
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "rm 2-3", "ko");
  ok("rm: 범위", Object.keys(state.sessions).length === 3, JSON.stringify(Object.keys(state.sessions)));
}
{
  const { handleRooms, state } = build({ sessions: S });
  // 1번 방에서 2-99 → 2~5번이 지워지고 자기 자신만 남는다
  await handleRooms("-100", "rm 2-99", "ko");
  ok("rm: 범위 끝은 목록 끝으로 줄여 받는다", Object.keys(state.sessions).length === 1,
     JSON.stringify(Object.keys(state.sessions)));
}
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "rm 9", "ko");
  ok("rm: 없는 단건 번호는 통째로 거절", Object.keys(state.sessions).length === 5);
  ok("rm: 거절이면 저장 안 함", saved === 0);
  ok("rm: 사용법을 준다", sent[0].text.startsWith("roomsUsage("), sent[0].text);
}
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "rm abc", "ko");
  ok("rm: 숫자 아닌 인자 거절", Object.keys(state.sessions).length === 5 && saved === 0);
}
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "rm", "ko");
  ok("rm: 번호 없으면 사용법", sent[0].text.startsWith("roomsUsage(") && saved === 0, sent[0].text);
}
{
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("688", "지워줘", "ko");
  ok("rm 이 아닌 인자 → 사용법", sent[0].text.startsWith("roomsUsage(") && saved === 0, sent[0].text);
}

// ── 막는 자리 ────────────────────────────────────────────────────────────
{
  // 지금 이 방을 지우면 다음 말 한마디에 되살아나고 세션 연결만 끊긴다
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("-100:11", "rm 4", "ko");       // 4번 = 테스트 = 지금 방
  ok("★ 지금 방은 못 지운다", state.sessions["-100:11"] !== undefined);
  ok("지금 방: 전용 문구", sent[0].text === "roomsRmHere()", sent[0].text);
  ok("지금 방: 저장 안 함", saved === 0);
}
{
  // 섞여 있어도 통째로 막는다 — 일부만 지우면 남은 번호가 밀린다
  const { handleRooms, state } = build({ sessions: S });
  await handleRooms("-100:11", "rm 2-4", "ko");
  ok("★ 지금 방이 범위에 섞이면 통째로 막는다", Object.keys(state.sessions).length === 5,
     JSON.stringify(Object.keys(state.sessions)));
  ok("섞였을 때도 저장 안 함", saved === 0);
}
{
  const { handleRooms, state } = build({ sessions: S });
  busy.add("-100:35");
  await handleRooms("688", "rm 2", "ko");
  ok("★ 도는 방은 못 지운다 (답이 갈 자리)", state.sessions["-100:35"] !== undefined);
  ok("도는 방: 이름을 대며 막는다", sent[0].text === "roomsRmBusy(봇유지보수 / 새 대화 08-21)", sent[0].text);
  ok("도는 방: 저장 안 함", saved === 0);
}
{
  const { handleRooms, state } = build({ sessions: S });
  busy.add("-100:99");
  await handleRooms("688", "rm 2-3", "ko");
  ok("도는 방이 범위에 섞여도 통째로 막는다", Object.keys(state.sessions).length === 5);
}

report();
