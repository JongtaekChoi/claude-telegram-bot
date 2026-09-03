// 건너뛴 예약 작업 알림. 예전엔 console.warn 한 줄이 전부라 회차가 통째로 사라져도 몰랐다
// (2026-08-31: 로컬 ctb 세션이 락을 잡고 있어 위생 점검과 auto lane 이 같이 날아갔다).
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const jobRooms =", "function buildSchedule") +
              cut("function scheduleTargets(job)", "async function runScheduled");

const factory = new Function(
  "state", "allowedIds", "console", "t", "send", "localLockInfo", "localKillMarkup", "BOT_LANG", "readLocalLock",
  `${block}\nreturn { scheduleTargets, notifySkipped, skipNoticed };`,
);

let sent, killMarkupUsed, lockInfo;
const realNow = Date.now;

function build({ allowed = ["100", "200"], titles = ["100", "200", "300"] } = {}) {
  sent = []; killMarkupUsed = 0;
  const state = { sessions: {} };
  for (const id of titles) state.sessions[id] = { title: `room${id}` };
  return {
    state,
    api: factory(
      state, allowed,
      { log() {}, warn() {}, error() {} },
      (lang, key, ...a) => `${key}(${a.join("|")})`,
      async (id, text, opts) => { sent.push({ id, text }); if (opts?.replyMarkup) killMarkupUsed++; },
      () => lockInfo,
      () => ({ inline_keyboard: [[{ text: "kill", callback_data: "local:kill" }]] }),
      "ko",
      () => null,
    ),
  };
}

// ── 원인 구분 ────────────────────────────────────────────────────────────
{
  const { api } = build();
  lockInfo = { pid: 42571, mins: 155, where: "큐브기획" };
  await api.notifySkipped({ cron: "30 12 * * 1,4", label: "저장소 위생 점검", chat: "100" }, { pid: 42571 });
  ok("락: 1건 발송", sent.length === 1, JSON.stringify(sent));
  ok("락: 지정한 방으로", sent[0]?.id === "100", sent[0]?.id);
  ok("락: Local 문구", sent[0]?.text.startsWith("scheduledSkippedLocal("), sent[0]?.text);
  ok("락: pid·경과분·방이름이 실림", sent[0]?.text.includes("42571|155|큐브기획"), sent[0]?.text);
  ok("락: 라벨 사용", sent[0]?.text.includes("저장소 위생 점검"));
  ok("락: 종료 버튼이 붙는다", killMarkupUsed === 1);
}
{
  const { api } = build();
  lockInfo = null;
  await api.notifySkipped({ cron: "0 9 * * *", label: "리포트", chat: "100" }, null);
  ok("busy: Busy 문구", sent[0]?.text.startsWith("scheduledSkippedBusy("), sent[0]?.text);
  ok("busy: 버튼 없음", killMarkupUsed === 0);
}
{
  const { api } = build();
  lockInfo = null;
  await api.notifySkipped({ cron: "*/5 * * * *", chat: "100" }, null);
  ok("라벨 없으면 cron 을 쓴다", sent[0]?.text.includes("*/5 * * * *"), sent[0]?.text);
}

// ── 도배 방지 (작업마다 한 시간에 한 번) ─────────────────────────────────
{
  const { api } = build();
  lockInfo = { pid: 1, mins: 1, where: "" };
  const job = { cron: "* * * * *", label: "잦은작업", chat: "100" };
  Date.now = () => 1_000_000;
  await api.notifySkipped(job, { pid: 1 });
  await api.notifySkipped(job, { pid: 1 });
  await api.notifySkipped(job, { pid: 1 });
  ok("1분 간격 3회 → 1건만", sent.length === 1, String(sent.length));
  Date.now = () => 1_000_000 + 59 * 60_000;
  await api.notifySkipped(job, { pid: 1 });
  ok("59분 뒤 → 여전히 1건", sent.length === 1, String(sent.length));
  Date.now = () => 1_000_000 + 60 * 60_000;
  await api.notifySkipped(job, { pid: 1 });
  ok("60분 뒤 → 2건", sent.length === 2, String(sent.length));
  Date.now = realNow;
}
{
  const { api } = build();
  lockInfo = null;
  Date.now = () => 2_000_000;
  await api.notifySkipped({ cron: "0 9 * * *", label: "A", chat: "100" }, null);
  await api.notifySkipped({ cron: "0 9 * * *", label: "B", chat: "100" }, null);
  ok("같은 cron 다른 라벨 → 각각 센다", sent.length === 2, String(sent.length));
  await api.notifySkipped({ cron: "0 13 * * *", label: "A", chat: "100" }, null);
  ok("같은 라벨 다른 cron → 각각 센다", sent.length === 3, String(sent.length));
  Date.now = realNow;
}

// ── 목적지 ───────────────────────────────────────────────────────────────
{
  const { state, api } = build();
  lockInfo = null;
  state.sessions["100"].muted = true;
  await api.notifySkipped({ cron: "0 9 * * *", label: "리포트", chat: "100" }, null);
  ok("뮤트된 방 → 무발송 (뮤트는 '여기서 아무것도 하지 마라')", sent.length === 0, JSON.stringify(sent));
}
{
  const { api } = build();
  lockInfo = null;
  await api.notifySkipped({ cron: "0 9 * * *", label: "리포트" }, null);
  ok("chat 없으면 예전처럼 allowedIds 전부", sent.map((s) => s.id).join(",") === "100,200",
     JSON.stringify(sent.map((s) => s.id)));
}
{
  const { api } = build();
  lockInfo = null;
  await api.notifySkipped({ cron: "0 9 * * *", label: "리포트", chat: ["100", "300"] }, null);
  ok("chat 배열 → 둘 다", sent.map((s) => s.id).join(",") === "100,300",
     JSON.stringify(sent.map((s) => s.id)));
}

// ── 경합 ─────────────────────────────────────────────────────────────────
{
  const { api } = build();
  lockInfo = null; // 그 사이 로컬 세션이 끝나 localLockInfo() 가 null 인 경우
  await api.notifySkipped({ cron: "0 9 * * *", label: "리포트", chat: "100" }, { pid: 999 });
  ok("락 파일이 사라져도 Local 문구를 유지", sent[0]?.text.startsWith("scheduledSkippedLocal("), sent[0]?.text);
  ok("방금 읽은 pid 를 쓴다", sent[0]?.text.includes("999|0|"), sent[0]?.text);
  ok("버튼도 유지", killMarkupUsed === 1);
}

report();
