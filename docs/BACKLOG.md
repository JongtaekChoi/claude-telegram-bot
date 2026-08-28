# Backlog

작업 대기열. **여기 한곳에만 둔다** — 전에는 `TODO.md`, `docs/ROADMAP.md`, 그리고 텔레그램
인수인계 메시지 셋으로 갈라져 서로 다른 말을 했고, 그래서 다음에 뭘 할지 물으면 이미 끝난 걸
제안하는 일이 생겼다.

규칙은 셋이다.

- 한 항목은 **한 줄**. 길어지면 `docs/design/` 에 문서를 쓰고 여기서 링크한다.
- 끝난 항목은 **지운다**. 이력은 `CHANGELOG.md` 와 `git log` 가 갖고 있다.
- 실봇으로 눈으로 확인하지 않은 건 **검증 빚**으로 옮긴다 — 배포 전에 비어 있어야 하는 칸이다.

## 다음

- [ ] **방별 페르소나** — 역할을 프로세스가 아니라 방으로 가른다. 세션 시작 때 페르소나를 고르고,
      봇을 합칠지는 프로젝트마다 고른다(강제 아님). **1·2·3·4는 0.4.13, 6a 는 0.5.0 에서 끝났다.**
      남은 것들은 값이 갈린다:
      - **6b — 역할별 `permissionMode`·`codexSandbox` + "권한이 안 지켜지는 경로 셋" 봉합.**
        6a 에서 떼어냈다 — 합칠 세 config 가 전부 `bypassPermissions` 라 보존할 권한 차이가 없고,
        그 구멍 셋도 이 필드를 넣을 때 비로소 생긴다. **역할별 권한이 실제로 필요해지면** 한다.
      - **8·9 — 오너 DM 에서 페르소나 만들기 + 그룹별 페르소나 집합 다중선택.** 새 프로젝트를
        붙이는 일이 SSH 에 묶여 있는 걸 푼다. 정의(`prompt`)만 `.claude-bot/personas/` 로 빼고
        권한(`dir`·`permissionMode`)은 config 에 남긴다. 6a 는 끝났으니 **`/allow` 뒤다.**
      - **5 — `/tell` 마커에서 목적지 빼고 방 선택 버튼으로.** 사람이 치는 `/tell` 은 이미 되고,
        바뀌는 건 *에이전트가* 넘길 때 주소를 누가 정하느냐뿐이다. 모델이 마커를 낼 일 자체가
        드물어서 **안 해도 아쉬울 게 없다.**
      → [design/room-personas.md](design/room-personas.md)
- [ ] **접수처 방 `/router`** — 특정 토픽에 갈 말이 상위 방으로 나가는 사고를 막는다. 접수처로
      켠 방은 실행하지 않고 "어디로?" 버튼을 띄운다. 설계 완료, 구현 전.
      → [design/room-router.md](design/room-router.md)
- [ ] **중지를 타이핑 없이** — `/stop` 은 치는 사이에 이미 실행된다. 후보: `/s` 별칭(공짜),
      실행이 길어지면 `[⏹ 중지]` 버튼 한 줄 띄우고 끝나면 지우기, 메시지 수정을 중지로 읽기
      (`edited_message` 를 `allowed_updates` 에 추가, bot.mjs:4520). 셋 다 독립이라 골라서 한다.
- [ ] **오너 DM 어드민 `/allow`** — 방 추가를 채팅에서. 봇이 config 를 쓰는 게 아니라 state 에
      적고 `allowedIds` 에 즉시 반영한다(승격 채택이 이미 쓰는 경로). 게이트는 방이 아니라 사람
      (`msg.from.id`). 설계 완료, 구현 전. → [design/owner-admin.md](design/owner-admin.md)
- [ ] **Claude ↔ Codex 방별 인수인계** — 설계 완료, 구현 전.
      → [design/provider-session-handoff.md](design/provider-session-handoff.md)
      (문서 끝의 "구현 전 확정할 결정" 5가지부터 정하고 시작한다)

## 검증 빚

구현·커밋됐지만 실봇으로 확인하지 않은 것.

- [ ] **`personas[].dir` (6a)** — 임시 config 로 부팅·작업 감시까지는 확인했다(폴더 두 개에
      `.ctb-outbox`·`.ctb-jobs` 생성, 없는 `dir` 은 안 만들고 로그, 하위 폴더에 떨어진 작업 기록을
      감시가 회수). **실봇에서 볼 것:** `dir` 을 가진 방에서 `/sessions` 가 그 폴더 세션을 보여주는지
      (제일 조용히 깨지는 자리), `/jobs` 가 폴더 태그와 함께 전부 보여주는지, 이미지 마커가 그 방
      아웃박스에서 읽히는지, `/status`·`/help` 의 작업 폴더가 방마다 다른지, 없는 `dir` 방에서
      안내가 뜨는지, `ctb --chat <그 방>` 이 그 폴더에서 열리는지.

## 나중

지금 필요하진 않지만 잊지 않으려고 적어둔다.

- [ ] **누적 비용 추적 `/cost`** — `runClaude` 가 이미 `res.cost` 를 준다. state 스키마만 늘리면 된다.
- [ ] **Claude 가 만든 파일 전송 — 이미지 아닌 것** — 이미지는 `.ctb-outbox` + `[[ctb-image: …]]`
      마커로 이미 나간다. 로그·CSV·zip 같은 걸 `sendDocument` 로 보내는 통로가 없다.
- [ ] **봇 간 공유 문서 (블랙보드)** — `.claude-bot/shared.md` 를 여러 페르소나 봇이 읽고 쓴다.
      코드 없이 persona 프롬프트 컨벤션만으로 가능. 위 봇 사이 인박스와 겹치는지 먼저 판단할 것.
- [ ] **봇 사이 파일 인박스** — 다른 봇 프로세스의 `.claude-bot/inbox/` 에 파일을 떨구는 방식.
      방별 페르소나로 봇을 합칠 수 있게 되면 대개 필요 없어져서 미뤘다. 봇을 일부러 나눠 두는
      구성에서 역할 사이 전달이 정말 필요해지면 그때 연다.
      → [design/room-relay.md](design/room-relay.md) 의 "다음 단계"
- [ ] **`[[ctb-tell:]]` 마커가 본문의 `]` 에서 조용히 깨진다** — 본문 그룹이 `[^\]]+?` 라
      (bot.mjs:1872) 대괄호가 들어가면 매치가 실패하고, **실패했다는 신호가 없어** 전달된 줄 안다.
      실제로 `personas[].dir` 을 적었다가 당했다. 본문을 `]]` 직전까지 허용하거나, 마커가 있었는데
      못 뽑았으면 그 방에 경고를 띄운다.
- [ ] **웹훅 모드** — `cfg.webhookUrl`, `node:http` 로 zero-dep 유지. 로컬 개발엔 폴링이 편하므로 설정으로 고른다.
- [ ] **데모 GIF** — `ctb` → 텔레그램 세션 연속성. → [images/SHOTLIST.md](images/SHOTLIST.md)

## 안 하기로 한 것

되살아나는 걸 막으려고 남긴다.

- **그룹 멘션 게이팅** — 멘션·리플라이일 때만 응답하는 방식. `allowedChatId` 가 이미 방 단위로
  막고, 그룹에 있는 사람은 그 방을 통과한 것으로 본다.
  → [design/group-chat-multi-user.md](design/group-chat-multi-user.md)
- **그룹 안에서 사람별 세션 분리** — 방 단위 분리로 확정. 같은 문서의 "열린 질문" 참고.
- **로컬 `ctb` 락을 머신 전역으로 두기** — 0.4.13 에서 방 단위로 뒤집었다. 같은 문서 참고.
- **`/panel` 다중 페르소나 라운드테이블** — 프로토타입까지 갔다가 폐기.
- **메시지를 지우면 중지** — 봇은 삭제를 알 수 없다. Bot API 에 일반 채팅의 삭제 업데이트가
  없다(비즈니스 계정 연결의 `deleted_business_messages` 뿐이라 해당 없음). 수정(`edited_message`)
  은 받을 수 있으니 그쪽으로 간다.
- **봇이 `config.json` 을 쓰는 것** — "어드민 방에서 설정을 고친다"로 검토. config 가 깨지면
  부팅 `JSON.parse` 에 보호가 없어 크래시 루프에 빠지고, 원격 관리하려던 기능이 실패할 때 SSH 를
  유일한 복구 수단으로 만든다. → [design/owner-admin.md](design/owner-admin.md)
- **어드민 "방" (`allowedChatId` 첫 항목)** — 권한 경계가 배열 순서에 실리고, 그룹이면 전원이
  어드민이 된다. 사람(`msg.from.id`) 으로 가른다. 같은 문서 참고.
- **방 키 단위 config 맵(`rooms`)** — 토픽 `threadId` 를 사전에 알 수 없고, 방별 선택이 state 와
  이중화되며, General 토픽의 방 키가 그룹 ID 와 같아 한 키에 두 의미가 겹친다.
  → [design/room-personas.md](design/room-personas.md) 의 "안 하기로 한 것"
