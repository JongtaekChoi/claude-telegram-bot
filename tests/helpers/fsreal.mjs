// 아웃박스 검증은 진짜 파일시스템을 봐야 의미가 있다(심볼릭 링크·크기·존재 여부). 스텁으로
// 흉내 내면 통과하는 테스트가 실제 경로 탈출을 못 잡는다 — persona-dir 스위트와 같은 이유다.
export { existsSync, statSync, realpathSync } from "node:fs";
export { basename } from "node:path";
