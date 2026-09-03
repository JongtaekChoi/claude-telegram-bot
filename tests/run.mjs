#!/usr/bin/env node
// tests/*.test.mjs 를 각각 별도 프로세스로 돌리고 합계를 낸다. 한 파일이 죽어도 나머지는 돈다 —
// 앵커가 밀렸을 때 어디가 깨졌는지 한 번에 보여야 하기 때문이다.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();
let failed = 0;

for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { encoding: "utf8" });
  const out = (r.stdout || "").trimEnd();
  const last = out.split("\n").filter(Boolean).pop() || "";
  console.log(`${f.replace(".test.mjs", "").padEnd(22)} ${last}`);
  if (out.includes("\n")) console.log(out.split("\n").slice(0, -1).map((l) => "  " + l).join("\n"));
  if (r.status !== 0) {
    failed++;
    if (r.stderr?.trim()) console.log(r.stderr.trim().split("\n").slice(0, 6).map((l) => "  ! " + l).join("\n"));
  }
}

console.log(`\n${failed ? `✗ ${failed}/${files.length} suite(s) failed` : `✓ ${files.length} suites passed`}`);
process.exit(failed ? 1 : 0);
