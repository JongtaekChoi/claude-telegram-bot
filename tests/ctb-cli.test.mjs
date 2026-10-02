// ctb 의 입구 — 모르는 하위 명령·`send --help`·모르는 플래그·`rooms`·`--file` 의 기본 방.
// 실제로 프로세스를 띄워 본다. 여기 버그는 "에러 대신 조용히 메시지를 보낸다"는 모양이라
// 종료 코드와 어디에 무엇이 찍혔는지가 곧 동작이다. (0.7.0 에서 `ctb rooms` 가 DM 세션을 깨웠다.)
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, cutCtb } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const dir = mkdtempSync(join(tmpdir(), "ctb-cli-"));
writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "x", allowedChatId: ["111", "-100"] }));
mkdirSync(join(dir, ".claude-bot"));
writeFileSync(join(dir, ".claude-bot", "state.json"), JSON.stringify({
  sessions: { "111": { title: "DM" }, "-100:7": { title: "Dev / 기획" }, "-100:9": { title: "Dev / 배포" } },
}));
const shot = join(dir, "shot.png"); writeFileSync(shot, "x");

// claudeBin 이 없으니 provider 가 뜨면 바로 "failed to start" 로 끝난다 — 뜨는지만 보면 된다.
const run = (args, env = {}) => spawnSync(process.execPath, [join(ROOT, "ctb.mjs"), ...args], {
  cwd: dir, encoding: "utf8", input: "",
  env: { ...process.env, BOT_CONFIG: "", CTB_CHAT_ID: "", PATH: "/nonexistent", ...env },
});

{
  const r = run(["roomz"]);
  eq("모르는 하위 명령은 2로 멈춘다", r.status, 2);
  ok("무엇이 틀렸는지 말한다", r.stderr.includes('unknown command "roomz"'), r.stderr);
  ok("provider 를 띄우지 않는다", !r.stderr.includes("failed to start"), r.stderr);
}
{
  const r = run(["rooms"]);
  eq("rooms 는 성공", r.status, 0);
  ok("방 키를 보여준다", r.stdout.includes("-100:7") && r.stdout.includes("Dev / 기획"), r.stdout);
  ok("어느 config 를 골랐는지 보여준다", r.stderr.includes(join(dir, "config.json")), r.stderr);
}
{
  const r = run(["send", "--help"]);
  eq("send --help 는 성공", r.status, 0);
  ok("플래그 목록이 나온다", r.stdout.includes("--file") && r.stdout.includes("--now"), r.stdout);
  ok("방 목록 에러가 아니다", !r.stderr.includes("--chat is required"), r.stderr);
}
{
  const r = run(["send", "--chat", "기획", "--nwo", "hello"]);
  eq("모르는 플래그는 2", r.status, 2);
  ok("플래그 이름을 댄다", r.stderr.includes("unknown option --nwo"), r.stderr);
}
{
  // 소켓이 없으니 연결에서 실패해야 한다 — 거기까지 왔다는 건 방이 정해졌다는 뜻이다.
  const r = run(["send", "--file", shot], { CTB_CHAT_ID: "-100:9" });
  ok("--file 은 CTB_CHAT_ID 를 기본 방으로 쓴다", r.stderr.includes("no bot listening"), r.stderr);
  const r2 = run(["send", "hello"], { CTB_CHAT_ID: "-100:9" });
  ok("글자는 CTB_CHAT_ID 로 가지 않는다", r2.stderr.includes("--chat is required"), r2.stderr);
}
{
  // 문장은 하위 명령으로 오인하지 않는다 — 대화형 프롬프트로 넘어간다.
  const r = run(["what did we do?"]);
  ok("문장은 provider 로 넘어간다", r.stderr.includes("failed to start"), r.stderr);
}

// 터미널 세션 프롬프트: 자기 방 키를 알려준다(파일용). 글자 목록에선 여전히 뺀다.
{
  const block = cutCtb("function sockPathFor(configPath) {", "\nfunction memoryPathFor")
    + cutCtb("function dispatchInstruction(configPath, st, ownRoom) {", "\n// `ctb send` — 프롬프트를");
  const sockDir = mkdtempSync(join(tmpdir(), "ctb-sock-"));
  mkdirSync(join(sockDir, ".claude-bot"));
  writeFileSync(join(sockDir, ".claude-bot", "ctb.sock"), "");
  const fn = new Function("existsSync", "basename", "join", "dirname",
    `${block}\nreturn dispatchInstruction;`)(
    (await import("node:fs")).existsSync, ...(await import("node:path").then((p) => [p.basename, p.join, p.dirname])));
  const st = { sessions: { "111": { title: "DM" }, "-100:7": { title: "기획" } } };
  const txt = fn(join(sockDir, "config.json"), st, "-100:7");
  ok("자기 방 키를 알려준다", txt.includes("attached to room -100:7"), txt);
  ok("옆방은 목록에 있다", txt.includes("111  — DM"), txt);
  ok("자기 방은 글자 목록에 없다", !txt.includes("-100:7  — 기획"), txt);
  const alone = fn(join(sockDir, "config.json"), { sessions: { "-100:7": { title: "기획" } } }, "-100:7");
  ok("옆방이 없어도 파일 안내는 붙는다", alone?.includes("attached to room -100:7") && !alone.includes("Rooms:"), alone);
}

report();
