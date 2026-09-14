// ctb 세션을 끝낼 때 보내는 인수인계 요약의 목적지. 토픽 방의 키는 `그룹:스레드` 인데 화이트리스트엔
// 그룹 id 만 있어서 통째로 비교하면 안 맞았고, "모르는 방"으로 보고 첫 방(DM)으로 물러섰다 —
// 토픽에서 한 작업 요약이 전부 DM 으로 갔다(2026-09-14). `/allow` 로 연 그룹도 ctb 가 config 만
// 봐서 같은 이유로 DM 으로 샜다.
import { cutCtb } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cutCtb("async function notifyTelegram(configPath, provider, sessionId, chatId) {", "\nmain().catch");

let posted;

function build({ cfg = {}, st = {}, summary = { text: "요약" } } = {}) {
  posted = [];
  return new Function(
    "readFileSync", "statePathFor", "summarizeSession", "projectDirFor", "process", "fetch",
    `${block}\nreturn notifyTelegram;`,
  )(
    (path) => (path === "cfg" ? JSON.stringify({ token: "T", ...cfg }) : JSON.stringify(st)),
    () => "state",
    async () => summary,
    () => "/proj",
    { env: {}, stderr: { write() {} } },
    async (url, init) => { posted.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; },
  );
}

const CFG = { allowedChatId: ["688", "-100"] };

{
  const notify = build({ cfg: CFG });
  await notify("cfg", "claude", "sid", "-100:573");
  ok("★ 토픽 세션 → 그 토픽으로", posted[0]?.chat_id === "-100" && posted[0]?.message_thread_id === 573,
     JSON.stringify(posted[0]));
  ok("토픽 세션 → DM 으로 안 샌다", posted[0]?.chat_id !== "688");
}
{
  const notify = build({ cfg: CFG });
  await notify("cfg", "claude", "sid", "-100");
  ok("그룹 자체 → 그룹으로, 스레드 없이", posted[0]?.chat_id === "-100" && posted[0]?.message_thread_id === undefined,
     JSON.stringify(posted[0]));
}
{
  const notify = build({ cfg: CFG });
  await notify("cfg", "claude", "sid", "688");
  ok("DM 세션 → DM 으로", posted[0]?.chat_id === "688" && posted[0]?.message_thread_id === undefined,
     JSON.stringify(posted[0]));
}
{
  // /allow 로 연 그룹 — config 에는 없고 state 에만 있다
  const notify = build({ cfg: { allowedChatId: ["688"] }, st: { allowedChatIds: ["-200"] } });
  await notify("cfg", "claude", "sid", "-200:9");
  ok("★ /allow 로 연 그룹의 토픽 → 그 토픽으로", posted[0]?.chat_id === "-200" && posted[0]?.message_thread_id === 9,
     JSON.stringify(posted[0]));
}
{
  // 승격으로 편입된 그룹
  const notify = build({ cfg: { allowedChatId: ["688"] }, st: { adoptedChatIds: ["-300"] } });
  await notify("cfg", "claude", "sid", "-300");
  ok("adopted 그룹 → 그 그룹으로", posted[0]?.chat_id === "-300", JSON.stringify(posted[0]));
}
{
  // 화이트리스트 밖(오타 등)은 여전히 첫 방으로 — 봇이 서비스하지 않는 방에 세션 내용을 안 보낸다
  const notify = build({ cfg: CFG });
  await notify("cfg", "claude", "sid", "-999:4");
  ok("화이트리스트 밖 → 첫 방으로 물러선다", posted[0]?.chat_id === "688" && posted[0]?.message_thread_id === undefined,
     JSON.stringify(posted[0]));
}
{
  const notify = build({ cfg: { ...CFG, ctbNotify: false } });
  await notify("cfg", "claude", "sid", "-100:573");
  ok("ctbNotify:false → 안 보낸다", posted.length === 0);
}
{
  const notify = build({ cfg: CFG, summary: { skip: true } });
  await notify("cfg", "claude", "sid", "-100:573");
  ok("넘길 게 없으면(SKIP) 안 보낸다", posted.length === 0);
}
{
  const notify = build({ cfg: CFG });
  await notify("cfg", "claude", "sid", "-100:573");
  ok("본문에 [터미널]/[local] 꼬리표", /\[(터미널|local)\]/.test(posted[0]?.text || ""), posted[0]?.text);
}

report();
