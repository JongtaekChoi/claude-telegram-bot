// 답장 문구가 텔레그램 HTML 로 안전하게 변환되는지. send() 는 변환 실패 시 평문으로
// 재전송하므로 무응답까지 가진 않지만, 원문에 <, &, 태그가 섞이면 서식이 통째로 날아간다.
// 인증 실패 문구는 원문(CLI 출력)을 코드펜스에 담으므로 특히 위험하다.
import { cut } from "./helpers/extract.mjs";
import { ok, report } from "./helpers/assert.mjs";

const api = new Function(
  cut("const STR = {", "\nconst t = (l, key, ...a) =>") +
  cut("const t = (l, key, ...a) =>", "\n// ") +
  cut("function escapeHtml", "\n// GitHub-flavored") +
  cut("function mdToTelegramHtml", "\n// opts.replyMarkup:") +
  "\nreturn { t, mdToTelegramHtml };",
)();

const RAW = "Failed to authenticate: OAuth session expired and could not be refreshed";
const RAW_HTML = 'Error: <policy> a & b > c "quoted" 그리고 <b>태그</b>';

const stripTags = (h) => h.replace(/<\/?(b|i|u|s|code|pre|a|blockquote|tg-spoiler)(\s[^>]*)?>/g, "");
const balanced = (h) => {
  const st = [];
  for (const m of h.matchAll(/<(\/?)(\w[\w-]*)(?:\s[^>]*)?>/g)) {
    if (m[1]) { if (st.pop() !== m[2]) return false; } else st.push(m[2]);
  }
  return st.length === 0;
};

for (const lang of ["ko", "en"]) {
  for (const [label, raw] of [["평범한 원문", RAW], ["HTML 특수문자 포함", RAW_HTML]]) {
    const html = api.mdToTelegramHtml(api.t(lang, "errClaudeAuth", raw));
    const bare = stripTags(html);
    ok(`${lang}/${label}: 태그 밖에 미이스케이프 < 없음`, !bare.includes("<"), bare.match(/<[^>]{0,30}/)?.[0]);
    ok(`${lang}/${label}: 미이스케이프 & 없음`, !/&(?!(amp|lt|gt|quot|#\d+);)/.test(bare));
    ok(`${lang}/${label}: 태그 짝이 맞음`, balanced(html), html.slice(0, 160));
    ok(`${lang}/${label}: 원문이 담김`, html.includes("authenticate") || html.includes("policy"));
  }
  const h = api.mdToTelegramHtml(api.t(lang, "errClaudeFailed", 7, "boom <x>"));
  ok(`${lang}: errClaudeFailed 도 이스케이프`, !stripTags(h).includes("<x>"), h);
  ok(`${lang}: credSplit 변환`, typeof api.mdToTelegramHtml(api.t(lang, "credSplit")) === "string");
  ok(`${lang}: credExpired 에 저장소가 남음`,
     api.mdToTelegramHtml(api.t(lang, "credExpired", "keychain")).includes("keychain"));
}

report();
