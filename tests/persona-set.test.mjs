// 그룹별 역할 집합 (`personaSet`). 그룹 = 프로젝트로 쓰는 배치에서 "이 그룹은 이 역할들"을
// 정해 두는 것이라, 집합은 **그룹 버킷**에 앉고 그 안의 토픽은 올려다본다.
// 이미 고른 역할은 집합에서 빠져도 그대로 둔다(grandfather) — 도중에 바꾸면 살아 있는 세션의
// 정체성과 메모리 파일이 같이 갈아탄다. → docs/design/room-personas.md
import { cut, cutCtb } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const block = cut("function personasFor(chatId) {", "\n// 시스템 프롬프트에 실릴 역할 본문");

const P = [
  { id: "dev", name: "개발자", prompt: "x" },
  { id: "plan", name: "기획자", prompt: "y" },
  { id: "ledger", name: "가계부", prompt: "z" },
];

function build(sessions) {
  return new Function(
    "PERSONAS", "state", "baseChatId",
    `${block}\nreturn { personasFor, roomPersona };`,
  )(P, { sessions }, (room) => String(room).split(":")[0]);
}

// ── 집합이 없으면 전부 ────────────────────────────────────────────────────
{
  const a = build({ "-100": { title: "그룹" } });
  eq("집합 없음: 전부 고를 수 있다", a.personasFor("-100").length, 3);
  eq("집합 없음: 기본값은 첫 역할", a.roomPersona("-100").id, "dev");
  eq("방을 몰라도(cron) 기본값", a.roomPersona(null).id, "dev");
}

// ── 그룹 집합 ────────────────────────────────────────────────────────────
{
  const a = build({ "-100": { personaSet: ["plan", "ledger"] } });
  eq("집합대로 좁혀진다", a.personasFor("-100").map((p) => p.id).join(), "plan,ledger");
  eq("기본값은 집합의 첫 번째 (전역 첫 역할이 아니다)", a.roomPersona("-100").id, "plan");
  // config 순서를 따른다 — 집합에 적힌 순서가 아니라. 그래야 그룹마다 기본값이 제각각이 안 된다.
  const b = build({ "-100": { personaSet: ["ledger", "plan"] } });
  eq("순서는 config 를 따른다", b.personasFor("-100").map((p) => p.id).join(), "plan,ledger");
}

// ── 토픽은 그룹을 올려다본다 ─────────────────────────────────────────────
{
  const a = build({
    "-100": { personaSet: ["plan"] },
    "-100:12": { title: "토픽" },
  });
  eq("토픽 방도 그룹 집합을 쓴다", a.personasFor("-100:12").map((p) => p.id).join(), "plan");
  eq("토픽 기본값도 그룹 집합에서", a.roomPersona("-100:12").id, "plan");
}
{
  // 토픽 버킷에 적힌 집합은 무시한다 — 집합은 그룹 단위다. 부모→자식 계층을 새로 만들지 않는다.
  const a = build({ "-100": {}, "-100:12": { personaSet: ["ledger"] } });
  eq("토픽에 적힌 집합은 안 본다", a.personasFor("-100:12").length, 3);
}

// ── 이미 고른 역할은 그대로 (grandfather) ────────────────────────────────
{
  const a = build({ "-100": { personaSet: ["plan"], persona: "dev" } });
  eq("집합 밖이어도 고른 역할은 유지", a.roomPersona("-100").id, "dev");
  ok("고르는 자리에서만 막는다", !a.personasFor("-100").some((p) => p.id === "dev"));
}
{
  // config 에서 **지워진** id 는 다르다 — 실행할 프롬프트가 아예 없으므로 기본값으로 떨어진다.
  const a = build({ "-100": { personaSet: ["plan"], persona: "gone" } });
  eq("없는 id 는 집합의 기본값으로", a.roomPersona("-100").id, "plan");
}

// ── 망가진 집합은 무시 ───────────────────────────────────────────────────
{
  eq("빈 배열은 집합 없음", build({ "-100": { personaSet: [] } }).personasFor("-100").length, 3);
  eq("배열이 아니면 무시", build({ "-100": { personaSet: "plan" } }).personasFor("-100").length, 3);
  // 집합에 적힌 id 가 전부 config 에서 사라지면 고를 역할이 0 이 된다 — 그 방은 통째로 멈춘다.
  const a = build({ "-100": { personaSet: ["gone1", "gone2"] } });
  eq("전부 사라진 집합은 없는 셈 친다", a.personasFor("-100").length, 3);
  eq("그래서 기본값도 살아 있다", a.roomPersona("-100").id, "dev");
}

// ── ctb 쪽 폴백이 봇과 같은 규칙인가 ─────────────────────────────────────
// 여기가 어긋나면 터미널과 봇이 다른 역할·다른 메모리 파일로 돈다.
{
  const ctbBlock = cutCtb("function personaFor(cfg, room, group) {", "\n// 방의 작업 폴더");
  const { personaFor } = new Function(`${ctbBlock}\nreturn { personaFor };`)();
  const cfg = { personas: P };
  eq("집합 없음: 첫 역할", personaFor(cfg, undefined, undefined).id, "dev");
  eq("집합: 그 첫 번째", personaFor(cfg, undefined, { personaSet: ["plan", "ledger"] }).id, "plan");
  eq("고른 역할이 우선", personaFor(cfg, { persona: "ledger" }, { personaSet: ["plan"] }).id, "ledger");
  eq("집합이 전부 사라졌으면 전역 첫 역할", personaFor(cfg, undefined, { personaSet: ["nope"] }).id, "dev");
  eq("역할이 없으면 null", personaFor({}, undefined, undefined), null);
}

report();
