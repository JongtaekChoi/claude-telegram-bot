// `ctb send --file` — 터미널이 준 파일을 그 방에 올린다. 에이전트를 돌리지 않는 길이라
// 세션·뮤트·락 규칙이 아니라 파일 검사와 승인만 거친다.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename, isAbsolute } from "node:path";
import { statSync } from "node:fs";
import { cut } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const block = cut("const OUTBOX_KINDS = {", "\n// 백그라운드 작업(.ctb-jobs)")
  + cut("function checkDispatchFiles(paths) {", "\nasync function dispatchFilesNow");

const dir = mkdtempSync(join(tmpdir(), "ctb-dispatch-"));
const png = join(dir, "shot.png"); writeFileSync(png, "x");
const pdf = join(dir, "doc.pdf"); writeFileSync(pdf, "x");
const huge = join(dir, "huge.png"); writeFileSync(huge, Buffer.alloc(11 * 1024 * 1024));

let sent, posted, replies;
function build({ sendOk = true, description } = {}) {
  sent = []; posted = []; replies = [];
  return new Function(
    "statSync", "basename", "isAbsolute", "tgSendOutbox", "send", "t", "BOT_LANG", "console",
    `${block}\nreturn { checkDispatchFiles, postDispatchFiles };`,
  )(
    statSync, basename, isAbsolute,
    async (room, kind, abs, caption) => {
      posted.push({ room, kind, name: basename(abs), caption });
      return sendOk ? { ok: true } : { ok: false, description };
    },
    async (room, text) => { sent.push({ room, text }); return 1; },
    (l, k, ...a) => `${k}:${a.join("|")}`, "ko", { warn: () => {}, error: () => {} },
  );
}

// ── 검사 ────────────────────────────────────────────────────────────────
{
  const api = build();
  const r = api.checkDispatchFiles([png, pdf]);
  eq("둘 다 통과", r.files?.length, 2);
  eq("확장자로 종류를 고른다", r.files.map((f) => f.kind).join(","), "image,file");
  ok("상대 경로는 거절", api.checkDispatchFiles(["shot.png"]).error?.includes("absolute"));
  ok("없는 파일은 거절", api.checkDispatchFiles([join(dir, "nope.png")]).error?.includes("no such file"));
  ok("폴더는 거절", api.checkDispatchFiles([dir]).error?.includes("not a file"));
  ok("사진 상한을 넘으면 거절", api.checkDispatchFiles([huge]).error?.includes("too large"));
  ok("빈 경로는 거절", api.checkDispatchFiles([""]).error?.includes("empty"));
}

// ── 전송 ────────────────────────────────────────────────────────────────
{
  const api = build();
  const files = api.checkDispatchFiles([png, pdf]).files;
  await api.postDispatchFiles("-100:5", files, "이거 봐", (r) => replies.push(r));
  eq("둘 다 보냈다", posted.length, 2);
  eq("방을 그대로 쓴다(토픽 포함)", posted[0].room, "-100:5");
  eq("캡션은 첫 장에만", posted[0].caption, "이거 봐");
  eq("둘째엔 캡션 없음", posted[1].caption, undefined);
  ok("터미널엔 성공을 알린다", replies[0]?.ok === true && replies[0].text.includes("2"));
  eq("실패 알림은 없다", sent.length, 0);
}
{
  const api = build({ sendOk: false, description: "file is too big" });
  const files = api.checkDispatchFiles([png]).files;
  await api.postDispatchFiles("-100", files, undefined, (r) => replies.push(r));
  ok("실패하면 방에도 알린다", sent.length === 1 && sent[0].text.startsWith("dispatchFilesFailed:"));
  ok("터미널엔 이유까지", replies[0]?.ok === false && replies[0].error.includes("file is too big"));
}

// ── 입구: 파일은 승인을 묻지 않는다 (0.7.0 에선 'run it' 을 물었고 ssh 쪽에선 아무도 못 눌러 만료됐다)
{
  const hd = cut("async function handleDispatch(req, emit) {", "\nfunction startDispatchServer");
  const calls = [];
  const mk = () => new Function(
    "allowedIds", "baseChatId", "DISPATCH_FILES_MAX", "checkDispatchFiles", "dispatchFilesNow", "state",
    "readLocalLock", "pendingDispatch", "PENDING_DISPATCH_MAX", "PENDING_DISPATCH_TTL", "dispatchNow",
    "askDispatch", "roomLabel",
    `${hd}\nreturn handleDispatch;`,
  )(
    ["-100"], (r) => String(r).split(":")[0], 10,
    (paths) => ({ files: paths.map((abs) => ({ abs })) }),
    async (room, files) => calls.push(["now", room, files.length]),
    { sessions: { "-100:5": { muted: true } } }, () => ({ room: "-100:5" }), new Map(), 20, 600_000,
    async () => calls.push(["run"]), async () => calls.push(["ask"]), (r) => `방(${r})`,
  );
  const out = [];
  await mk()({ room: "-100:5", files: [png] }, (o) => out.push(o));
  eq("--now 없이도 바로 올린다", calls[0]?.[0], "now");
  ok("승인 대기 상태를 내지 않는다", !out.some((o) => o.status === "awaiting-approval"));
  ok("뮤트·로컬 락 방에도 올린다", calls.length === 1);
  calls.length = 0; out.length = 0;
  await mk()({ room: "-100:6", text: "hi" }, (o) => out.push(o));
  eq("글자는 여전히 승인을 묻는다", calls[0]?.[0], "ask");
  ok("대기 상태가 어디서 눌러야 하는지 말한다",
    out[0]?.status === "awaiting-approval" && out[0].hint.includes("방(-100:6)") && out[0].hint.includes("10 min"));
}

report();
