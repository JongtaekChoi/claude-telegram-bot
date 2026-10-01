// 봇이 방에 들어왔을 때(my_chat_member) 모르는 방이면 안내한다. 허용된 그룹에서 토픽을 켜면
// 슈퍼그룹으로 승격되며 새 ID 가 생기는데, 가입 알림이 승격 메시지보다 먼저 와서 곧 물려받을 방에
// "허용 목록에 없습니다" 가 나갔다(2026-09-19).
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const block = cut("const MEMBER_GREET_DELAY_MS =", "\n// ── 파일 전송(아웃박스)");

async function run(upd, { allowed = [], adoptDuringWait = false } = {}) {
  const allowedIds = [...allowed];
  const greeted = [];
  let waited = 0;
  const fakeSetTimeout = (fn, ms) => {
    waited += ms;
    if (adoptDuringWait) allowedIds.push(String(upd.chat.id));
    fn();
  };
  const { handleMyChatMember } = new Function(
    "allowedIds", "greetUnknownRoom", "langOf", "setTimeout",
    `${block}\nreturn { handleMyChatMember };`,
  )(allowedIds, async (room) => { greeted.push(room); }, () => "ko", fakeSetTimeout);
  await handleMyChatMember(upd);
  return { greeted, waited };
}

const join = (id, type) => ({ chat: { id, type }, new_chat_member: { status: "member" } });

{
  const r = await run(join(-1004394315697, "supergroup"), { adoptDuringWait: true });
  ok("승격 직후: 기다리는 사이 물려받았으면 안내하지 않는다", r.greeted.length === 0 && r.waited > 0, JSON.stringify(r));
}
{
  const r = await run(join(-1009, "supergroup"));
  ok("모르는 슈퍼그룹: 기다린 뒤 안내한다", r.greeted.length === 1 && r.waited > 0, JSON.stringify(r));
}
{
  const r = await run(join(-5009, "group"));
  ok("일반 그룹은 승격이 끼어들 일이 없어 바로 안내한다", r.greeted.length === 1 && r.waited === 0, JSON.stringify(r));
}
{
  const r = await run(join(-1001, "supergroup"), { allowed: ["-1001"] });
  ok("이미 허용된 방은 조용히", r.greeted.length === 0 && r.waited === 0, JSON.stringify(r));
}
{
  const r = await run({ chat: { id: -1002, type: "supergroup" }, new_chat_member: { status: "left" } });
  ok("나간 건 알리지 않는다", r.greeted.length === 0, JSON.stringify(r));
}

report();
