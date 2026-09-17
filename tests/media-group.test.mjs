// 여러 개를 한 번에 보낸 첨부(미디어 그룹). 예전엔 사진만 골라서, 파일로 보낸 PNG 두 장이
// 통째로 사라지고 캡션도 없으니 빈 메시지로 무시됐다(2026-09-17).
import { cut } from "./helpers/extract.mjs";
import { ok, eq, report } from "./helpers/assert.mjs";

const { mergeMediaGroup } = new Function(
  `${cut("function pickAttachment(msg) {", "\nasync function downloadAttachment")}
${cut("function mergeMediaGroup(msgs) {", "\n// 일반 그룹에서")}
return { mergeMediaGroup };`,
)();

const photo = (id) => ({ photo: [{ file_id: `${id}-small` }, { file_id: id }] });
const doc = (id, name) => ({ document: { file_id: id, file_name: name } });

{
  const m = mergeMediaGroup([{ ...doc("d1", "IMG_3542.PNG"), chat: { id: 1 } }, doc("d2", "IMG_3543.PNG")]);
  eq("파일 앨범: 둘 다 모은다", m._mediaGroup.length, 2);
  eq("파일 앨범: 원래 파일명을 들고 간다", m._mediaGroup[0].name, "IMG_3542.PNG");
  eq("파일 앨범: file_id", m._mediaGroup[1].fileId, "d2");
  eq("첫 메시지의 나머지 필드는 남긴다", m.chat?.id, 1);
}
{
  const m = mergeMediaGroup([{ ...photo("p1"), caption: "봐줘" }, photo("p2")]);
  eq("사진 앨범: 가장 큰 크기", m._mediaGroup[0].fileId, "p1");
  eq("사진 앨범: 이름은 없다", m._mediaGroup[0].name, null);
  eq("캡션은 본문으로", m.text, "봐줘");
  eq("caption 필드는 비운다", m.caption, undefined);
}
{
  const m = mergeMediaGroup([photo("p1"), { video: { file_id: "v1", file_name: "a.mp4" } }]);
  eq("사진+동영상 섞인 앨범", m._mediaGroup.map((a) => a.fileId).join(","), "p1,v1");
}
{
  const m = mergeMediaGroup([{ caption: "첨부 없음" }]);
  ok("첨부 없는 조각은 건너뛴다", Array.isArray(m._mediaGroup) && m._mediaGroup.length === 0);
}

report();
