// 로컬 세션을 가리키는 안내의 수명. "이 방을 로컬 ctb 세션이 잡고 있습니다 + [종료]" 가
// 세션이 끝나도 그대로 남아 거짓말이 됐다(2026-09-14). 봇은 세션이 끝나는 순간을 모르므로
// 보낸 안내를 적어두고 락을 주기적으로 본다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const LOCAL_NOTICE_POLL_MS =", "\n// 로컬 세션 강제 종료");

let calls, sentN, lock, saved, NOW;

function build({ notices = [] } = {}) {
  calls = []; sentN = 0; saved = 0;
  const state = { localNotices: notices.map((n) => ({ ...n })) };
  const api = new Function(
    "state", "saveState", "checkLocalLock", "readLocalLock", "tg", "baseChatId", "send", "t",
    "localKillMarkup", "setInterval", "clearInterval", "Date",
    `${block}\nreturn { sendLocalBusy, trackLocalNotice, sweepLocalNotices, armLocalNoticeSweep, localNotices };`,
  )(
    state, () => { saved++; },
    (room) => !!lock && (!lock.room || lock.room === String(room)),
    () => lock,
    async (method, body) => {
      calls.push({ method, body });
      // 48시간 넘은 메시지는 못 지운다 — id 가 음수면 그런 척
      if (method === "deleteMessage" && body.message_id < 0) return { ok: false, description: "message can't be deleted" };
      return { ok: true };
    },
    (room) => String(room).split(":")[0],
    async () => 100 + ++sentN,
    (l, k) => k,
    () => ({ inline_keyboard: [[{ text: "kill", callback_data: "local:kill" }]] }),
    () => ({ unref() {} }),
    () => {},
    { now: () => NOW },
  );
  return { ...api, state };
}
NOW = 1_800_000_000_000;

// ── 잡고 있다는 안내 ─────────────────────────────────────────────────────
{
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  await a.sendLocalBusy("-100:35", "ko");
  ok("busy: 보내고 추적한다", a.localNotices().length === 1 && a.localNotices()[0].kind === "busy",
     JSON.stringify(a.localNotices()));
  ok("busy: state 에 저장한다 (재시작해도 이어 치우게)", saved >= 1);
}
{
  // 잡힌 동안 여러 번 말을 걸어도 한 장만 남는다
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  await a.sendLocalBusy("-100:35", "ko");
  await a.sendLocalBusy("-100:35", "ko");
  await a.sendLocalBusy("-100:35", "ko");
  ok("busy: 같은 방에 쌓지 않는다", a.localNotices().length === 1, JSON.stringify(a.localNotices()));
  ok("busy: 이전 것은 지운다", calls.filter((c) => c.method === "deleteMessage").length === 2,
     JSON.stringify(calls.map((c) => c.method)));
  ok("busy: 남은 건 마지막 것", a.localNotices()[0].id === 103, JSON.stringify(a.localNotices()));
}
{
  // 다른 방의 안내는 건드리지 않는다
  lock = { pid: 1 };
  const a = build();
  await a.sendLocalBusy("-100:35", "ko");
  await a.sendLocalBusy("-100:11", "ko");
  ok("busy: 방마다 따로 한 장씩", a.localNotices().length === 2);
  ok("busy: 다른 방 것은 안 지운다", !calls.some((c) => c.method === "deleteMessage"));
}

// ── 세션이 끝나면 치운다 ─────────────────────────────────────────────────
{
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  await a.sendLocalBusy("-100:35", "ko");
  lock = null;                                   // ctb 종료 — 락이 사라졌다
  await a.sweepLocalNotices();
  ok("★ 세션이 끝나면 잡고 있다는 안내를 지운다",
     calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 101),
     JSON.stringify(calls));
  ok("지울 때 그룹 id 로 보낸다 (메시지 id 는 그룹 단위)",
     calls.find((c) => c.method === "deleteMessage").body.chat_id === "-100");
  ok("치운 건 목록에서 빠진다", a.localNotices().length === 0);
}
{
  // 세션이 아직 살아 있으면 그대로 둔다
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  await a.sendLocalBusy("-100:35", "ko");
  await a.sweepLocalNotices();
  ok("세션이 살아 있으면 안 지운다", a.localNotices().length === 1
     && !calls.some((c) => c.method === "deleteMessage"), JSON.stringify(calls));
}
{
  // 락이 다른 방으로 옮겨가면 — 이 방은 더는 안 잡혀 있다
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  await a.sendLocalBusy("-100:35", "ko");
  lock = { pid: 2, room: "-100:11" };
  await a.sweepLocalNotices();
  ok("락이 다른 방으로 가면 이 방 안내는 치운다", a.localNotices().length === 0, JSON.stringify(a.localNotices()));
}

// ── 버튼만 떼는 안내 (/local 상태 · 건너뛴 예약 작업) ────────────────────
{
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  a.trackLocalNotice("688", 500, "button");
  lock = null;
  await a.sweepLocalNotices();
  ok("button: 메시지는 남기고", !calls.some((c) => c.method === "deleteMessage"), JSON.stringify(calls));
  const e = calls.find((c) => c.method === "editMessageReplyMarkup");
  ok("button: 버튼만 뗀다", e && e.body.message_id === 500 && e.body.reply_markup.inline_keyboard.length === 0,
     JSON.stringify(calls));
}
{
  // 버튼은 락 하나를 겨누므로 어느 방이든 락이 살아 있으면 유효하다
  lock = { pid: 1, room: "-100:35" };
  const a = build();
  a.trackLocalNotice("688", 500, "button");
  await a.sweepLocalNotices();
  ok("button: 다른 방 락이라도 살아 있으면 버튼 유지", a.localNotices().length === 1 && calls.length === 0,
     JSON.stringify(calls));
}

// ── 지우기가 막히면 ──────────────────────────────────────────────────────
{
  lock = null;
  const a = build({ notices: [{ room: "-100:35", id: -7, kind: "busy", at: NOW }] });
  await a.sweepLocalNotices();
  ok("지우기가 막히면 버튼이라도 뗀다",
     calls.some((c) => c.method === "editMessageReplyMarkup" && c.body.message_id === -7), JSON.stringify(calls));
}
{
  // 48시간 넘은 건 손을 못 대니 잊는다 — 매번 시도해 봐야 실패만 쌓인다
  lock = null;
  const a = build({ notices: [{ room: "-100:35", id: 9, kind: "busy", at: NOW - 49 * 3600_000 }] });
  await a.sweepLocalNotices();
  ok("너무 오래된 건 호출 없이 잊는다", a.localNotices().length === 0 && calls.length === 0, JSON.stringify(calls));
}

// ── 재시작 뒤 ────────────────────────────────────────────────────────────
{
  // 재시작 전에 보낸 안내가 state 에 남아 있으면 이어서 치운다
  lock = null;
  const a = build({ notices: [
    { room: "-100:35", id: 201, kind: "busy", at: NOW },
    { room: "688", id: 202, kind: "button", at: NOW },
  ] });
  await a.sweepLocalNotices();
  ok("재시작 뒤: 남은 busy 를 지운다", calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 201));
  ok("재시작 뒤: 남은 button 은 버튼만 뗀다", calls.some((c) => c.method === "editMessageReplyMarkup" && c.body.message_id === 202));
  ok("재시작 뒤: 목록이 빈다", a.localNotices().length === 0);
}
{
  lock = null;
  const a = build();
  await a.sweepLocalNotices();
  ok("추적할 게 없으면 아무것도 안 부른다", calls.length === 0 && saved === 0);
}
{
  const a = build();
  a.trackLocalNotice("688", null, "button");
  ok("보내기에 실패해 id 가 없으면 추적 안 한다", a.localNotices().length === 0);
}

report();
