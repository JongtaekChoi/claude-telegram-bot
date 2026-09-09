// 포럼 상위 토픽 접수처. 포럼 그룹은 열면 기본으로 상위에 서고, 알림에서 들어가도 그렇다 —
// 그래서 특정 토픽에 갈 말이 상위 방으로 나가는 사고가 반복됐다. 상위 방도 실행 방이라
// 조용히 돌아버리고, 알아차렸을 땐 엉뚱한 세션이 오염됐고 정작 그 말이 갈 방은 못 들었다.
// → docs/design/room-router.md
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const ROUTE_QUIET_MS =", "// 에이전트에게 옆방에 메시지 넘기는 법을");

let sent, handled, NOW, busyRooms;

function build({ sessions = {}, allowed = ["-100"], lastRunAt = {} } = {}) {
  sent = []; handled = []; busyRooms = new Set();
  const state = { sessions };
  const chatRuntime = new Map();
  const api = new Function(
    "state", "allowedIds", "knownRooms", "baseChatId", "tgTarget", "rt", "chatRuntime",
    "send", "t", "handle", "Date",
    `${block}\nreturn { routerSiblings, routeShortLabel, routePreview, askRoute, runRoute, routeInFlow, pendingRoutes, ROUTE_QUIET_MS };`,
  )(
    state, allowed,
    () => Object.entries(sessions)
      .filter(([r, b]) => b?.title && allowed.includes(String(r.split(":")[0])))
      .map(([room, b]) => ({ room, title: b.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    (room) => String(room).split(":")[0],
    (room) => {
      const [c, th] = String(room).split(":");
      return { chat_id: c, ...(th ? { message_thread_id: Number(th) } : {}) };
    },
    (chatId) => ({ lastRunAt: lastRunAt[String(chatId)] || 0 }),
    { get: (r) => (busyRooms.has(String(r)) ? { busy: true } : undefined) },
    async (id, text, opts) => { sent.push({ id, text, markup: opts?.replyMarkup }); },
    (l, k, ...a) => `${k}(${a.join("|")})`,
    async (msg) => { handled.push(msg); },
    { now: () => NOW },
  );
  return api;
}

const FORUM = {
  "-100": { title: "봇유지보수", forum: true },
  "-100:11": { title: "봇유지보수 / 테스트" },
  "-100:35": { title: "봇유지보수 / 플랜" },
  "-100:520": { title: "봇유지보수 / 기획" },
};

// ── 어디에 버튼이 뜨는가 ─────────────────────────────────────────────────
{
  const a = build({ sessions: FORUM });
  const s = a.routerSiblings("-100");
  ok("상위 방: 형제 토픽 셋", s.length === 3, JSON.stringify(s.map((r) => r.room)));
  ok("상위 방: 자기 자신은 뺀다", !s.some((r) => r.room === "-100"));
}
{
  const a = build({ sessions: FORUM });
  ok("토픽 방: 그 자체가 목적지 → 안 묻는다", a.routerSiblings("-100:35").length === 0);
}
{
  const a = build({ sessions: { "-100": { title: "일반그룹" }, "-100:9": { title: "일반그룹 / x" } } });
  ok("포럼 아님 → 안 묻는다", a.routerSiblings("-100").length === 0);
}
{
  const a = build({ sessions: { "-100": { title: "봇유지보수", forum: true } } });
  ok("형제가 없으면 빈 목록", a.routerSiblings("-100").length === 0);
}
{
  // 다른 그룹의 토픽은 형제가 아니다
  const a = build({
    sessions: { ...FORUM, "-200:4": { title: "다른그룹 / 토픽" } },
    allowed: ["-100", "-200"],
  });
  const s = a.routerSiblings("-100");
  ok("다른 그룹 토픽은 안 섞인다", s.length === 3 && !s.some((r) => r.room.startsWith("-200")));
}

// ── 조용한 창 (10분) ─────────────────────────────────────────────────────
{
  NOW = 1_800_000_000_000;
  ok("ROUTE_QUIET_MS 는 10분", build().ROUTE_QUIET_MS === 600_000);
}
{
  NOW = 1_800_000_000_000;
  const a = build({ lastRunAt: { "-100": NOW - 60_000 } });
  ok("1분 전 실행 → 안 묻고 그냥 돈다", a.routeInFlow("-100") === true);
}
{
  NOW = 1_800_000_000_000;
  const a = build({ lastRunAt: { "-100": NOW - 20 * 60_000 } });
  ok("20분 전 실행 → 다시 묻는다", a.routeInFlow("-100") === false);
}
{
  NOW = 1_800_000_000_000;
  const a = build({ lastRunAt: { "-100": NOW - 600_000 } });
  ok("정확히 10분 → 경계는 다시 묻는 쪽", a.routeInFlow("-100") === false);
}
{
  NOW = 1_800_000_000_000;
  const a = build({});
  ok("한 번도 안 돈 방 → 묻는다", a.routeInFlow("-100") === false);
}
{
  // 형제 토픽으로 보낸 건 상위 방의 창을 열지 않는다 — runRoute 는 목적지 방만 건드린다
  NOW = 1_800_000_000_000;
  const a = build({ sessions: FORUM, lastRunAt: { "-100:35": NOW - 1000 } });
  ok("토픽에서 돈 것은 상위 창을 안 연다", a.routeInFlow("-100") === false);
}

// ── 버튼 모양 ────────────────────────────────────────────────────────────
{
  const a = build({ sessions: FORUM });
  ok("라벨: 그룹 이름을 뗀다", a.routeShortLabel("봇유지보수 / 기획", "봇유지보수") === "기획");
  ok("라벨: 접두사가 다르면 그대로", a.routeShortLabel("딴그룹 / 기획", "봇유지보수") === "딴그룹 / 기획");
  ok("라벨: 부모 이름이 없으면 그대로", a.routeShortLabel("봇유지보수 / 기획", undefined) === "봇유지보수 / 기획");
}
{
  const a = build({ sessions: FORUM });
  await a.askRoute("-100", { text: "이거 고쳐줘" }, "ko", a.routerSiblings("-100"));
  ok("버튼: 1건만 보낸다", sent.length === 1, String(sent.length));
  const rows = sent[0].markup.inline_keyboard;
  ok("버튼: 토픽 2개씩 줄바꿈 + 마지막 줄", rows.length === 3, JSON.stringify(rows.map((r) => r.length)));
  const last = rows[rows.length - 1];
  ok("버튼: [여기서 실행]·[안 보냄]", last.length === 2
    && last[0].callback_data.endsWith(":here") && last[1].callback_data.endsWith(":x"), JSON.stringify(last));
  const cbs = rows.slice(0, 2).flat().map((b) => b.callback_data);
  ok("버튼: 목적지가 방 키를 싣는다",
    cbs.every((c) => /^rt:\d+:-100:\d+$/.test(c)), JSON.stringify(cbs));
  ok("버튼: 제목순으로 는다 (기획·테스트·플랜)",
    cbs.join() === "rt:1:-100:520,rt:1:-100:11,rt:1:-100:35", JSON.stringify(cbs));
}
{
  const a = build({ sessions: FORUM });
  busyRooms.add("-100:35");
  await a.askRoute("-100", { text: "x" }, "ko", a.routerSiblings("-100"));
  const labels = sent[0].markup.inline_keyboard.flat().map((b) => b.text);
  ok("돌고 있는 방에는 ⏳", labels.some((x) => x.includes("⏳")), JSON.stringify(labels));
}
{
  const a = build({ sessions: FORUM });
  await a.askRoute("-100", { text: "  여러   칸이   섞인   긴 줄  " }, "ko", []);
  ok("미리보기: 공백을 접는다", sent[0].text.includes("여러 칸이 섞인 긴 줄"), sent[0].text);
}
{
  const a = build({ sessions: FORUM });
  const long = "가".repeat(200);
  ok("미리보기: 80자에서 자른다", a.routePreview({ text: long }, "ko").length === 80);
  ok("미리보기: 첨부만이면 전용 문구", a.routePreview({}, "ko") === "routeAttachOnly()");
  ok("미리보기: 캡션도 본다", a.routePreview({ caption: "사진 설명" }, "ko") === "사진 설명");
}

// ── 목적지로 옮기기 ──────────────────────────────────────────────────────
{
  const a = build({ sessions: FORUM });
  const orig = {
    text: "이거 고쳐줘", message_id: 991, chat: { id: -100, type: "supergroup" },
    photo: [{ file_id: "AAA" }], caption: "로그", from: { id: 688 },
  };
  await a.runRoute(orig, "-100:35");
  ok("옮기기: handle 1회", handled.length === 1);
  const m = handled[0];
  ok("옮기기: 방 키가 바뀐다", String(m.chat.id) === "-100" && m.message_thread_id === 35,
     `${m.chat.id} / ${m.message_thread_id}`);
  ok("옮기기: message_id 를 뗀다", m.message_id === undefined);
  ok("옮기기: 첨부·캡션·발신자가 따라간다",
     m.photo?.[0]?.file_id === "AAA" && m.caption === "로그" && m.from?.id === 688);
  ok("옮기기: 목적지에서 다시 안 묻는다", m._router === true);
  ok("옮기기: 병합 창에 다시 안 붙잡힌다", m._drained === true);
  ok("옮기기: 머리말을 안 붙인다 (_relay 없음)", m._relay === undefined);
  ok("옮기기: 원본은 안 건드린다", orig.message_id === 991 && orig._router === undefined);
}
{
  const a = build({ sessions: FORUM });
  await a.runRoute({ text: "x", chat: { id: -100 } }, "-100");
  ok("옮기기: 상위 방(스레드 없음)이면 thread 도 없다", handled[0].message_thread_id === undefined);
  ok("옮기기: is_topic_message 도 안 붙는다", handled[0].is_topic_message === undefined);
}

// ── 밀린 요청 상한 ───────────────────────────────────────────────────────
{
  const a = build({ sessions: FORUM });
  for (let i = 0; i < 25; i++) await a.askRoute("-100", { text: `m${i}` }, "ko", []);
  ok("보류는 20개까지만 쌓인다", a.pendingRoutes.size <= 20, String(a.pendingRoutes.size));
  ok("오래된 것부터 밀려난다", !a.pendingRoutes.has("1"));
  ok("최근 것은 남는다", a.pendingRoutes.has("25"));
}

report();
