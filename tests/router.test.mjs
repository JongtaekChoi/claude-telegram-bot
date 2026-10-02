// 포럼 상위 토픽 접수처. 포럼 그룹은 열면 기본으로 상위에 서고, 알림에서 들어가도 그렇다 —
// 그래서 특정 토픽에 갈 말이 상위 방으로 나가는 사고가 반복됐다. 상위 방도 실행 방이라
// 조용히 돌아버리고, 알아차렸을 땐 엉뚱한 세션이 오염됐고 정작 그 말이 갈 방은 못 들었다.
// → docs/design/room-router.md
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const ROUTE_QUIET_MS =", "// 에이전트에게 옆방에 메시지 넘기는 법을");

let sent, handled, NOW, busyRooms, menus, saved, logs;

function build({ sessions = {}, allowed = ["-100"], lastRunAt = {}, roomRuns = {} } = {}) {
  sent = []; handled = []; busyRooms = new Set(); menus = []; saved = 0; logs = [];
  const state = { sessions };
  const chatRuntime = new Map();
  const api = new Function(
    "state", "allowedIds", "knownRooms", "baseChatId", "tgTarget", "rt", "chatRuntime",
    "send", "t", "handle", "Date", "chatBucket", "saveState", "sendMenu", "roomLabel", "BOT_LANG", "console",
    `${block}\nreturn { routerSiblings, routerDesk, routerOff, routeShouldAsk, handleRouter, deskGuardInstruction, routeShortLabel, routePreview, askRoute, runRoute, routeInFlow, pendingRoutes, ROUTE_QUIET_MS };`,
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
    { get: (r) => {
      const run = roomRuns[String(r)];
      const busy = busyRooms.has(String(r));
      return busy || run ? { busy: busy || undefined, lastRunAt: run } : undefined;
    } },
    async (id, text, opts) => { sent.push({ id, text, markup: opts?.replyMarkup }); },
    (l, k, ...a) => `${k}(${a.join("|")})`,
    async (msg) => { handled.push(msg); },
    { now: () => NOW },
    (room) => (sessions[String(room)] ||= {}),
    () => { saved++; },
    async (id, text, markup) => { menus.push({ id, text, markup }); },
    (room) => sessions[String(room)]?.title || String(room),
    "ko",
    { log: (m) => logs.push(m), error: () => {} },
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
  ok("버튼: 토픽 2개씩 줄바꿈 + 마지막 두 줄", rows.length === 4, JSON.stringify(rows.map((r) => r.length)));
  const last = rows[rows.length - 2];
  ok("버튼: [여기서 실행]·[안 보냄]", last.length === 2
    && last[0].callback_data.endsWith(":here") && last[1].callback_data.endsWith(":x"), JSON.stringify(last));
  // 끄는 길은 이 질문에서만 알 수 있다 — 안내 문구 대신 버튼으로 준다.
  const off = rows[rows.length - 1];
  ok("버튼: [그만 묻기] 가 자기 줄에 붙는다", off.length === 1 && off[0].callback_data === "rr:off",
     JSON.stringify(off));
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
  await a.runRoute(orig, "-100:35", "-100");
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
  await a.runRoute({ text: "x", chat: { id: -100 } }, "-100", "-100");
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

// ── 묻는 방인가 (routerDesk) ─────────────────────────────────────────────
{
  const a = build({ sessions: FORUM });
  ok("접수처: 포럼 상위 토픽", a.routerDesk("-100"));
  ok("접수처 아님: 토픽 방", !a.routerDesk("-100:35"));
  ok("접수처 아님: 포럼이 아닌 그룹", !a.routerDesk("-200"));
  ok("접수처 아님: DM", !a.routerDesk("688"));
}

// ── 끄는 스위치 (routerOff) ──────────────────────────────────────────────
{
  ok("기본은 켜짐", !build({ sessions: FORUM }).routerOff("-100"));
  ok('"off" 면 꺼진다', build({ sessions: { "-100": { ...FORUM["-100"], router: "off" } } }).routerOff("-100"));
  // 모르는 값은 **묻는 쪽**으로 실패해야 한다 — state.json 손편집이 보호를 조용히 없애면 안 된다.
  for (const bad of ["on", "OFF", true, 1, "", null]) {
    ok(`${JSON.stringify(bad)} 는 끄지 않는다`,
       !build({ sessions: { "-100": { ...FORUM["-100"], router: bad } } }).routerOff("-100"));
  }
}

// ── 물어야 하나 (routeShouldAsk) — 예전엔 게이트 안에 있어 테스트가 없던 자리 ──
{
  const a = build({ sessions: FORUM });
  NOW = 2_000_000_000_000;
  ok("평소엔 묻는다", a.routeShouldAsk("-100", { text: "x" }));
  ok("되넣은 말은 안 묻는다 (_router)", !a.routeShouldAsk("-100", { _router: true }));
  ok("주소가 정해져 온 말은 안 묻는다 (_relay)", !a.routeShouldAsk("-100", { _relay: "-100:35" }));
}
{
  NOW = 2_000_000_000_000;
  const a = build({ sessions: FORUM, lastRunAt: { "-100": NOW - 60_000 } });
  ok("조용한 창 안이면 안 묻는다", !a.routeShouldAsk("-100", { text: "x" }));
}
{
  NOW = 2_000_000_000_000;
  const a = build({ sessions: { "-100": { ...FORUM["-100"], router: "off" }, "-100:35": FORUM["-100:35"] } });
  ok("꺼진 방은 안 묻는다", !a.routeShouldAsk("-100", { text: "x" }));
  ok("꺼져도 형제 목록은 그대로 — /router 가 보여줘야 한다", a.routerSiblings("-100").length === 1);
}

// ── /router ──────────────────────────────────────────────────────────────
{
  const sessions = structuredClone(FORUM);
  const a = build({ sessions });
  await a.handleRouter("-100", "off", "ko");
  ok("off: state 에 적는다", sessions["-100"].router === "off");
  ok("off: 저장한다", saved === 1, String(saved));
  ok("off: 방에 알린다", sent.length === 1 && sent[0].text === "routerTurnedOff()", JSON.stringify(sent));
  await a.handleRouter("-100", "on", "ko");
  ok("on: 필드를 지운다 (false 로 남기지 않는다)", sessions["-100"].router === undefined);
  ok("on: 방에 알린다", sent[1].text === "routerTurnedOn()");
}
{
  const sessions = structuredClone(FORUM);
  const a = build({ sessions });
  await a.handleRouter("-100", "", "ko");
  ok("인자 없음: 메뉴로 상태를 보여준다", menus.length === 1, JSON.stringify(menus));
  ok("인자 없음: 버튼은 하나 (반대 상태로)", menus[0].markup.inline_keyboard[0].length === 1);
  ok("인자 없음: 켜져 있으면 끄는 버튼", menus[0].markup.inline_keyboard[0][0].callback_data === "rr:off");
  ok("인자 없음: 형제 토픽을 같이 보여준다", menus[0].text.includes("기획"), menus[0].text);
  ok("인자 없음: state 를 안 건드린다", saved === 0 && sessions["-100"].router === undefined);
}
{
  const sessions = { "-100": { ...FORUM["-100"], router: "off" }, "-100:35": FORUM["-100:35"] };
  const a = build({ sessions });
  await a.handleRouter("-100", "", "ko");
  ok("꺼져 있으면 켜는 버튼", menus[0].markup.inline_keyboard[0][0].callback_data === "rr:on");
}
{
  const sessions = structuredClone(FORUM);
  const a = build({ sessions });
  await a.handleRouter("-100:35", "off", "ko");
  await a.handleRouter("688", "off", "ko");
  ok("접수처가 아닌 방: 거절", sent.every((s) => s.text === "routerNotDesk()"), JSON.stringify(sent));
  ok("접수처가 아닌 방: state 를 안 건드린다", saved === 0 && sessions["-100:35"].router === undefined);
}
{
  // 토픽이 아직 없는 상위 방에서도 미리 꺼둘 수 있다 — 나중에 토픽이 생기면 그대로 적용된다.
  const sessions = { "-100": { title: "봇유지보수", forum: true } };
  const a = build({ sessions });
  await a.handleRouter("-100", "off", "ko");
  ok("형제가 없어도 끌 수 있다", sessions["-100"].router === "off" && saved === 1);
}

// ── 꺼진 방에 붙는 시스템 프롬프트 ───────────────────────────────────────
{
  const a = build({ sessions: FORUM });
  ok("켜진 방에는 안 붙는다 (버튼으로 이미 묻는다)", a.deskGuardInstruction("-100") === null);
}
{
  const a = build({ sessions: { "-100": { ...FORUM["-100"], router: "off" }, "-100:35": FORUM["-100:35"] } });
  const g = a.deskGuardInstruction("-100");
  ok("꺼진 방에는 붙는다", typeof g === "string" && g.length > 0);
  ok("도구를 쓰기 전에 판단하라고 시킨다", /Before you do anything/.test(g), String(g).slice(0, 80));
  ok("넘기는 길까지 알려준다", /ctb-tell/.test(g));
}
{
  const a = build({ sessions: { "-100": { title: "봇유지보수", forum: true, router: "off" } } });
  ok("형제가 없으면 안 붙는다 (헷갈릴 방이 없다)", a.deskGuardInstruction("-100") === null);
}
{
  const a = build({ sessions: { "-100:35": { ...FORUM["-100:35"], router: "off" } } });
  ok("토픽 방에는 안 붙는다", a.deskGuardInstruction("-100:35") === null);
}

// ── 넘어간 토픽에 질문도 남긴다 ─────────────────────────────────────────
// 안 남기면 그 토픽에는 답만 떠서, 거기만 보는 사람에게는 질문 없는 답이 된다.
{
  const a = build({ sessions: FORUM });
  await a.runRoute({ text: "이거 고쳐줘", chat: { id: -100 } }, "-100:35", "-100");
  ok("안내를 목적지 토픽으로 보낸다", sent.length === 1 && sent[0].id === "-100:35", JSON.stringify(sent));
  ok("출처 방 이름을 싣는다", sent[0].text.startsWith("routeIncoming(봇유지보수)"), sent[0].text);
  ok("원문을 인용으로 싣는다", sent[0].text.includes("> 이거 고쳐줘"), sent[0].text);
}
{
  // 질문이 답보다 **먼저** 떠야 한다 — 순서가 뒤집히면 고아 답 문제가 그대로다.
  const a = build({ sessions: FORUM });
  const order = [];
  await a.runRoute({ text: "x", chat: { id: -100 } }, "-100:35", "-100");
  order.push(...sent.map(() => "notice"), ...handled.map(() => "handled"));
  ok("안내 → 실행 순서", order.join() === "notice,handled", order.join());
}
{
  const a = build({ sessions: FORUM });
  await a.runRoute({ photo: [{ file_id: "p" }], chat: { id: -100 } }, "-100:35", "-100");
  ok("첨부만: 상위 방에 있다고 적는다", sent[0].text.includes("routeAttachLeft"), sent[0].text);
}
{
  const a = build({ sessions: FORUM });
  await a.runRoute({ text: "가".repeat(400), chat: { id: -100 } }, "-100:35", "-100");
  const quoted = sent[0].text.split("> ")[1];
  ok("긴 글은 300자에서 자른다", quoted.length === 300 && quoted.endsWith("…"), String(quoted.length));
}
{
  // 출처를 모르면(옛 보류 항목 등) 안내 없이 말만 간다 — 틀린 출처를 적느니 안 적는다.
  const a = build({ sessions: FORUM });
  await a.runRoute({ text: "x", chat: { id: -100 } }, "-100:35");
  ok("출처가 없으면 안내를 안 보낸다", sent.length === 0 && handled.length === 1);
}
{
  const a = build({ sessions: FORUM });
  await a.askRoute("-100", { text: "x" }, "ko", a.routerSiblings("-100"));
  const pending = a.pendingRoutes.get("1");
  ok("출처는 붙잡아 둔 말에 묶인다", pending.from === "-100", JSON.stringify(pending?.from));
  ok("물어본 시각도 같이 적어 둔다", typeof pending.at === "number");
}
{
  const a = build({ sessions: FORUM });
  ok("미리보기 기본 길이는 그대로 80", a.routePreview({ text: "가".repeat(200) }, "ko").length === 80);
}

// ── 마지막으로 대화한 토픽을 맨 앞에 ────────────────────────────────────
// 탭 수는 그대로다. 순서만 바꾸고 고르는 건 사람이라, 틀려도 대가가 없다.
{
  NOW = 2_000_000_000_000;
  const a = build({ sessions: FORUM, roomRuns: { "-100:35": NOW - 60_000, "-100:11": NOW - 600_000 } });
  await a.askRoute("-100", { text: "x" }, "ko", a.routerSiblings("-100"));
  const cbs = sent[0].markup.inline_keyboard.slice(0, 2).flat().map((b) => b.callback_data);
  ok("최근 대화한 토픽이 맨 앞", cbs[0] === "rt:1:-100:35", JSON.stringify(cbs));
  ok("그다음이 두 번째", cbs[1] === "rt:1:-100:11", JSON.stringify(cbs));
  const labels = sent[0].markup.inline_keyboard.flat().map((b) => b.text);
  ok("첫 버튼에만 '방금'", labels.filter((x) => x.includes("routeRecent")).length === 1, JSON.stringify(labels));
}
{
  // 오래된 방은 순서만 앞이고 꼬리표는 안 붙는다 — 붙이면 추천처럼 보여 잘못 유도한다.
  NOW = 2_000_000_000_000;
  const a = build({ sessions: FORUM, roomRuns: { "-100:35": NOW - 3 * 60 * 60_000 } });
  await a.askRoute("-100", { text: "x" }, "ko", a.routerSiblings("-100"));
  const labels = sent[0].markup.inline_keyboard.flat().map((b) => b.text);
  ok("세 시간 전이면 꼬리표 없음", !labels.some((x) => x.includes("routeRecent")), JSON.stringify(labels));
  ok("그래도 맨 앞", sent[0].markup.inline_keyboard[0][0].callback_data === "rt:1:-100:35");
}
{
  // 재시작 직후엔 활동 기록이 없다 — 예전처럼 제목순.
  const a = build({ sessions: FORUM });
  await a.askRoute("-100", { text: "x" }, "ko", a.routerSiblings("-100"));
  const cbs = sent[0].markup.inline_keyboard.slice(0, 2).flat().map((b) => b.callback_data);
  ok("기록이 없으면 제목순 그대로", cbs.join() === "rt:1:-100:520,rt:1:-100:11,rt:1:-100:35", JSON.stringify(cbs));
}

// ── 기록 ────────────────────────────────────────────────────────────────
// 가정으로 논쟁하지 않으려고 남긴다. 본문은 안 남긴다.
{
  const a = build({ sessions: FORUM });
  await a.askRoute("-100", { text: "비밀 얘기" }, "ko", a.routerSiblings("-100"));
  ok("물었다는 기록", logs.some((m) => m === "Router ask: -100 (3 siblings)"), JSON.stringify(logs));
  ok("본문은 안 남긴다", !logs.some((m) => m.includes("비밀")), JSON.stringify(logs));
}

report();
