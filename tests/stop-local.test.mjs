// 이 방에 봇 작업이 없을 때 /stop 이 로컬 ctb 세션 안내를 띄우는 자리.
// 락은 봇에 하나라, 방을 안 가리면 다른 그룹에서 /stop 을 쳐도 남의 방 세션과 [종료] 버튼이
// 떴다(2026-09-17). 누르면 그 방 작업이 죽는다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut('if (text === "/stop" || text.startsWith("/stop ")) {', "\n    const reset = text.includes");

let sent, lock;
async function run(chatId) {
  sent = [];
  const AsyncFunction = (async () => {}).constructor;
  const f = new AsyncFunction(
    "text", "chatId", "r", "l", "cancelHold", "dropQueued", "clearHeld", "send", "t",
    "checkLocalLock", "localLockInfo", "trackLocalNotice", "localKillMarkup",
    `${block}\n    return "fallthrough";\n  }\n  return "no-match";`,
  );
  return f(
    "/stop", chatId, { busy: false }, "ko", () => false, () => {}, () => {},
    async (c, text, opts) => { sent.push({ c, text, opts }); return 1; },
    (l, k) => k,
    (room) => !!lock && (!lock.room || lock.room === String(room)),
    () => lock && { pid: lock.pid, mins: 3, room: lock.room, where: lock.room || "" },
    () => {}, () => ({ kill: true }),
  );
}

lock = { pid: 7, room: "-200:5" };
await run("-100:1");
ok("다른 방의 로컬 세션은 안내하지 않는다", sent.length === 1 && sent[0].text === "stopNoop", JSON.stringify(sent));

await run("-200:5");
ok("이 방을 잡은 세션이면 종료 버튼과 함께 안내한다",
   sent.length === 1 && sent[0].text === "localActive" && sent[0].opts?.replyMarkup, JSON.stringify(sent));

lock = { pid: 7 }; // 0.4.13 이전 ctb — 어느 방인지 모르면 전 방을 잡은 것으로 본다
await run("-100:1");
ok("방 정보 없는 옛 락은 어느 방에서든 안내한다", sent[0]?.text === "localActive", JSON.stringify(sent));

lock = null;
await run("-100:1");
ok("락이 없으면 할 일 없다고 답한다", sent.length === 1 && sent[0].text === "stopNoop", JSON.stringify(sent));

report("stop-local");
