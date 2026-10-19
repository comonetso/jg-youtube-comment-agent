# 유튜브 댓글 에이전트 대시보드

(주)제이지그룹 AI PM 과제 TRACK 2 — 지정 채널 영상을 불러와 AI 가 영상 속 말을 짚은 댓글 초안을 쓰고, 버튼 한 번에 크롬 '유튜브1' 프로필이 열려 **한 글자씩 입력 → 게시 → 내 댓글 확인**까지 하는 로컬 대시보드.

- 시연 영상: https://youtu.be/ZBi4pQLhUqY
- 설계 이유: [docs/제작의도.md](docs/제작의도.md)

## 필요한 것

- **Windows**(대시보드는 macOS 도 가능 — 테스트 영상 만들기·화면 녹화 도구는 Windows 전용) · **Node.js 22 이상** · **Google Chrome**
- 댓글 AI: `ANTHROPIC_API_KEY`(`.env`) 가 있으면 Anthropic API, 없으면 이 PC 의 `claude` CLI(Claude Code)를 씁니다
- 시연 영상 합치기(선택): ffmpeg

## 처음 한 번

```bash
npm install                      # playwright-core 하나 (브라우저는 설치된 Chrome 을 씀)
node tools/login-profile.mjs     # '유튜브1' 전용 크롬이 뜬다 → 구글 로그인 → 창 닫기
node tools/check-login.mjs       # {"loggedIn":true} 이면 준비 끝
```

전용 프로필 폴더는 `%LOCALAPPDATA%\jg-youtube-agent\profiles\` 아래에 생깁니다(평소 쓰는 크롬 프로필과 별개).

## 실행

```bash
npm start                        # http://127.0.0.1:4310
```

① **영상 불러오기** → ② 카드를 누르거나 링크를 붙여 넣으면 고민 한 줄 · 댓글 초안 · 근거 → ③ **댓글 달기**(또는 **연습** — 입력까지만 하고 게시 안 함).

## 설정 — `config.json`

| 항목 | 뜻 |
|---|---|
| `profiles` | 게시용 크롬 프로필 목록(`id`·`name`·`userDataDir`). 추가하면 ③의 선택 칸에 나온다 |
| `collector` | 영상 읽기 전용 프로필(로그인 없음). `hideAutomationFlag` 는 자막을 읽으려고 이 프로필에만 쓴다 |
| `channels` | 불러오기 · 게시 허용 채널 5곳 |
| `testVideos` | 게시를 허용하는 본인 테스트 영상 |
| `comment` | 글자 수(띄어쓰기 넣고 ≤120 · 빼고 ≥40) · 브랜드 · `adLabel`(광고 표시, 실제 운영 땐 `true`) |
| `limits.dailyMaxComments` | 하루 게시 상한(앱 전체, 기본 10) |
| `typing.delayMs` | 한 글자 입력 간격(ms) |

## 운영 규칙(서버가 강제)

허용 채널 · 테스트 영상만 / 영상당 1개(결과불명도 잠금) / 하루 상한 / 시간순 기록 `data/log.json`.

## 구조

```
src/server.mjs     대시보드 서버(127.0.0.1 전용) · API · 실시간 진행(SSE)
src/rules.mjs      허용 범위 · 영상당 1개 · 하루 상한 · 기록
src/feed.mjs       채널 RSS 최신 영상(라이브 제외)
src/collect.mjs    영상 정보 · 자막 · 인기 댓글 읽기(읽기 전용 프로필)
src/ai.mjs         고민 한 줄 · 댓글 초안(재시도 포함)
src/validate.mjs   글자 수 · 링크 · 해시태그 · 지어낸 후기 · 근거 인용 대조 · 광고 표시
src/post.mjs       크롬 '유튜브1' 로 한 글자씩 입력 · 게시 · 내 댓글 확인 · 캡처
src/browser.mjs    크롬 전용 프로필 열기(Playwright, 보이는 창 / 화면 밖 / 헤드리스)
public/            세 칸 화면
tools/             로그인 · 확인 · 테스트 영상 만들기·올리기 · 시연 녹화·합치기
```

## 시연 녹화(사용자 화면을 덮지 않음)

```bash
JG_BROWSER_MODE=offscreen JG_OFFSCREEN_SIZE=1600,900 JG_RECORD_POST_DIR=data/recording/run npm start
node tools/record-demo.mjs --offscreen            # --rehearsal 이면 게시 대신 연습
node tools/compose-demo.mjs <marks.json> <post-폴더>  # 한 편으로 합치기
```

## 주의

- 실제 게시는 **본인 채널 테스트 영상**에서만 시연했습니다. 시청자로 위장한 홍보 댓글은 유튜브 스팸 정책·광고 표시 지침 위험이 있습니다(제작 의도 6항).
- `.env`(키) · `data/`(기록·캡처·녹화) · 크롬 프로필은 저장소에 넣지 않습니다.
