// 아웃박스 — 에이전트가 답변 끝에 마커를 붙여 파일을 되돌려 보내는 길. 0.6.0 에서 사진만 되던 것을
// 영상·문서까지 넓혔다. 검증(폴더 밖·심볼릭 링크·크기·확장자)은 세 종류가 같은 자리를 쓴다.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename, realpathSync, statSync, existsSync } from "./helpers/fsreal.mjs";
import { cut } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const block = cut("const OUTBOX_KINDS = {", "\n// 백그라운드 작업(.ctb-jobs)")
  + cut("function validateOutboxItem(dir, kind, rawName, rawCap) {", "\n// 에이전트 답변을 사용자에게 전달한다");

const root = mkdtempSync(join(tmpdir(), "ctb-outbox-"));
const box = join(root, ".ctb-outbox");
mkdirSync(box);
writeFileSync(join(box, "chart.png"), "x");
writeFileSync(join(box, "clip.mp4"), "x");
writeFileSync(join(box, "report.pdf"), "x");
writeFileSync(join(box, "notes.txt"), "x");
writeFileSync(join(box, "big.png"), Buffer.alloc(11 * 1024 * 1024));
writeFileSync(join(root, "outside.png"), "x");
symlinkSync(join(root, "outside.png"), join(box, "link.png"));

const warned = [];
const api = new Function(
  "IMAGE_SEND", "outboxDir", "basename", "join", "existsSync", "statSync", "realpathSync", "sep", "console",
  `${block}\nreturn { validateOutboxItem, extractOutboxItems, outboxKindOf, OUTBOX_KINDS };`,
)(
  true, () => box, basename, join, existsSync, statSync, realpathSync, "/",
  { warn: (m) => warned.push(m), error: () => {} },
);
const { validateOutboxItem: val, extractOutboxItems: extract, outboxKindOf } = api;

// ── 종류 고르기 ─────────────────────────────────────────────────────────
eq("확장자로 사진", outboxKindOf("/a/b/shot.PNG"), "image");
eq("확장자로 영상", outboxKindOf("/a/b/clip.mov"), "video");
eq("나머지는 문서", outboxKindOf("/a/b/report.pdf"), "file");
eq("확장자가 없으면 문서", outboxKindOf("/a/b/Makefile"), "file");

// ── 검증 ────────────────────────────────────────────────────────────────
ok("사진: 아웃박스 안의 png", val(box, "image", "chart.png")?.name === "chart.png");
ok("영상: mp4 는 video 로", val(box, "video", "clip.mp4")?.kind === "video");
ok("문서: pdf 는 확장자를 안 가린다", val(box, "file", "report.pdf")?.kind === "file");
ok("문서: txt 도 된다", val(box, "file", "notes.txt")?.kind === "file");
ok("사진 마커에 pdf 는 거절", val(box, "image", "report.pdf") === null);
ok("영상 마커에 png 는 거절", val(box, "video", "chart.png") === null);
ok("10MB 넘는 사진은 거절", val(box, "image", "big.png") === null);
ok("10MB 넘어도 문서로는 보낸다", val(box, "file", "big.png")?.kind === "file");
ok("경로를 줘도 basename 만", val(box, "image", "../../etc/chart.png")?.name === "chart.png");
ok("폴더 밖을 가리키는 심볼릭 링크는 거절", val(box, "image", "link.png") === null);
ok("없는 파일은 거절", val(box, "image", "nope.png") === null);
ok("모르는 종류는 거절", val(box, "sticker", "chart.png") === null);
eq("캡션은 다듬어서 들어온다", val(box, "image", "chart.png", "  보세요  ")?.caption, "보세요");

// ── 마커 뽑기 ───────────────────────────────────────────────────────────
{
  const r = extract("정리했습니다.\n\n[[ctb-image: chart.png | 추이]]\n[[ctb-file: report.pdf]]", "-100");
  eq("마커는 본문에서 사라진다", r.text, "정리했습니다.");
  eq("나온 순서대로", r.items.map((i) => i.kind).join(","), "image,file");
  eq("캡션도 따라온다", r.items[0].caption, "추이");
}
{
  const r = extract("[[ctb-image: nope.png]] 본문", "-100");
  eq("유효하지 않아도 마커는 노출하지 않는다", r.text, "본문");
  eq("보낼 것은 없다", r.items.length, 0);
}
{
  const r = extract("[[ctb-video: clip.mp4]]", "-100");
  eq("파일만 있으면 본문은 빈다", r.text, "");
  eq("영상 하나", r.items.length, 1);
}
{
  const r = extract("마커 없는 답", "-100");
  eq("마커가 없으면 그대로", r.text, "마커 없는 답");
}

report();
