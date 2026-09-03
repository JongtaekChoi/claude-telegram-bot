// 의존성 0 을 지키려고 테스트 러너도 직접 둔다. 파일 하나가 프로세스 하나다.
let pass = 0;
const failures = [];

export function ok(name, cond, extra = "") {
  if (cond) pass++;
  else failures.push(`${name}${extra ? `  → ${extra}` : ""}`);
}

export const eq = (name, got, want) =>
  ok(name, Object.is(got, want), got === want ? "" : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

export function report() {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`${failures.length ? "✗" : "✓"} ${pass} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}
