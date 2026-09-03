// bot.mjs 는 export 가 없는 단일 파일이다. 테스트는 소스에서 블록을 **떼어내** 스텁 위에서
// 돌린다 — 복사본을 두면 코드가 바뀌어도 테스트는 옛것을 통과시키기 때문이다.
//
// 대가는 앵커가 밀리면 깨진다는 것이고, 실제로 그렇게 조용히 죽은 적이 있다(`SyntaxError:
// Unexpected token ')'` 만 나와서 원인을 못 찾았다). 그래서 못 찾으면 **그 자리에서 앵커
// 이름을 대고** 죽는다. `anchors.test.mjs` 가 모든 앵커를 미리 훑어 한 번에 알려준다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SRC = readFileSync(join(ROOT, "bot.mjs"), "utf8");

export function cut(from, to) {
  const i = SRC.indexOf(from);
  if (i < 0) throw new Error(`bot.mjs 에서 시작 앵커를 못 찾음: ${JSON.stringify(from)}`);
  if (SRC.indexOf(from, i + 1) >= 0) throw new Error(`시작 앵커가 여러 곳에 있음: ${JSON.stringify(from)}`);
  const j = SRC.indexOf(to, i + from.length);
  if (j < 0) throw new Error(`끝 앵커를 못 찾음 (${JSON.stringify(from)} 이후): ${JSON.stringify(to)}`);
  return SRC.slice(i, j);
}
