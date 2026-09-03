// schedule[].chat — 예약 작업이 방을 지목한다. 없으면 한 프로세스가 여러 역할을 맡을 때
// 기획 리포트를 개발자 역할이 쓰고 결과가 모든 방에 뿌려진다.
// 부팅 검증이 중요한 이유: send() 에는 화이트리스트 검사가 없어 오타 하나면 아무 방으로나 나간다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const jobRooms =", "let schedule = buildSchedule();") +
              cut("function scheduleTargets(job)", "async function runScheduled");

function build({ schedule = [], cron = null, allowed = ["100", "200"], sessions = {} } = {}) {
  const errors = [];
  const api = new Function(
    "cfg", "state", "allowedIds", "console", "parseCron", "baseChatId", "t", "send", "BOT_LANG",
    "localLockInfo", "localKillMarkup", "readLocalLock",
    `${block}\nreturn { jobRooms, buildSchedule, scheduleTargets };`,
  )(
    { schedule },
    { cron, sessions },
    allowed,
    { log() {}, warn() {}, error: (m) => errors.push(String(m)) },
    (c) => (c === "bad" ? null : { c }),
    (room) => String(room).split(":")[0],
    (l, k, ...a) => `${k}(${a.join("|")})`,
    async () => {},
    "ko",
    () => null,
    () => ({}),
    () => null,
  );
  return { ...api, errors };
}

// ── jobRooms ─────────────────────────────────────────────────────────────
{
  const { jobRooms } = build();
  ok("chat 없음 → 빈 배열", jobRooms({}).length === 0);
  ok("문자열 하나 → 배열로", jobRooms({ chat: "100" }).join() === "100");
  ok("숫자도 문자열로", jobRooms({ chat: -100 }).join() === "-100");
  ok("배열 그대로", jobRooms({ chat: ["100", "200"] }).join() === "100,200");
  ok("빈 값은 걸러진다", jobRooms({ chat: ["100", "", null] }).join() === "100");
}

// ── 부팅 검증 ────────────────────────────────────────────────────────────
{
  const b = build({ schedule: [{ cron: "0 9 * * *", prompt: "p", chat: "100" }] });
  ok("허용된 방 → 통과", b.buildSchedule().length === 1);
}
{
  const b = build({ schedule: [{ cron: "0 9 * * *", prompt: "p", chat: "999" }] });
  ok("★ 허용목록에 없는 방 → 작업 전체를 버린다", b.buildSchedule().length === 0);
  ok("버린 이유를 크게 찍는다", b.errors.some((e) => e.includes("not in allowedChatId") && e.includes("999")),
     JSON.stringify(b.errors));
}
{
  const b = build({ schedule: [{ cron: "0 9 * * *", prompt: "p", chat: ["100", "999"] }] });
  ok("하나만 틀려도 작업 전체를 버린다", b.buildSchedule().length === 0);
}
{
  const b = build({ schedule: [{ cron: "0 9 * * *", prompt: "p", chat: "100:353" }] });
  ok("토픽 방 키는 그룹 ID 로 검증", b.buildSchedule().length === 1, JSON.stringify(b.errors));
}
{
  const b = build({ schedule: [{ cron: "bad", prompt: "p" }, { cron: "0 9 * * *" }] });
  ok("깨진 cron·프롬프트 없음은 예전처럼 걸러진다", b.buildSchedule().length === 0);
  ok("각각 이유를 찍는다", b.errors.length === 2, JSON.stringify(b.errors));
}
{
  const b = build({ schedule: [{ cron: "0 9 * * *", prompt: "p" }] });
  ok("chat 없는 예전 작업은 그대로 통과", b.buildSchedule().length === 1);
}
{
  const b = build({
    schedule: [{ cron: "0 9 * * *", prompt: "c", chat: "100" }],
    cron: [{ cron: "0 10 * * *", prompt: "d", chat: "200" }],
  });
  const s = b.buildSchedule();
  ok("config 와 동적(state.cron) 이 합쳐진다", s.length === 2);
  ok("출처가 표시된다", s.map((j) => j.source).join() === "config,dynamic", JSON.stringify(s.map((j) => j.source)));
}

// ── scheduleTargets ──────────────────────────────────────────────────────
{
  const b = build();
  ok("chat 없으면 allowedIds 전부", b.scheduleTargets({}).join() === "100,200");
  ok("chat 있으면 그 방만", b.scheduleTargets({ chat: "100" }).join() === "100");
}
{
  const b = build({ sessions: { 100: { muted: true } } });
  ok("뮤트된 방은 건너뛴다", b.scheduleTargets({ chat: "100" }).length === 0);
  ok("뮤트 아닌 방만 남는다", b.scheduleTargets({}).join() === "200");
}

report();
