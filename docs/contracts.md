# 모듈 계약 — 담당끼리 맞추는 약속

과제 원문: `../track-2-marketing-agent.pdf` (정본). Node 22, ESM(`.mjs`), **외부 패키지 없음**(Node 내장만).

## ✅ 변경 공지 3 — 최종 구조 (2026-10-20)

- `browser.mjs` 기본 전략은 **attach**(크롬을 사람처럼 띄우고 Playwright `connectOverCDP` 로 붙음). 방식 `show`(게시 기본) · `offscreen`(모니터 밖) · `headless`. `JG_BROWSER_MODE` 로 전체 강제.
- **영상 읽기는 `config.collector`(로그인 없는 프로필, offscreen)** 로 따로 연다 — 게시용 프로필과 번갈아 열면 잠금이 겹쳐 멈추거나 로그인이 늦게 읽혔다.
- 자막 0자 원인 = Chrome 155 가 조종 통로를 열면 켜는 `navigator.webdriver`. `collector.hideAutomationFlag` 로 **읽기용에만** `--disable-blink-features=AutomationControlled`(게시용에는 쓰지 않음 — 사용자 결정). 헤드리스는 옵션을 넣어도 실패.
- `post.mjs`: 로그인 판정은 값이 생길 때까지 기다리고 '안 됨'이면 최대 30초 새로 고쳐 재확인 · 게시 창 영상 음소거·정지 · 성공 때도 캡처 · `JG_RECORD_POST_DIR` 이면 게시 탭 화면을 프레임으로 저장(화면 밖 녹화).
- `feed.mjs`: 라이브("Live streaming of …")는 목록에서 뺀다. `config.comment.adLabel`: 광고 표시 켜기/끄기(기본 끔).
- `cdp.mjs`(Aside) 는 더 쓰지 않는다 — 대조 시험용으로만 남김.

## 🛑 변경 공지 2 — 크롬은 기본 화면에 안 보이게(헤드리스)

- 구현 담당의 Aside 시험은 끝날 때까지 그대로 해도 된다(사용자이 감수하기로 하심). 새로 시작하는 시험은 `browser.mjs` 를 쓴다.
- `browser.mjs` 는 **기본 헤드리스**(화면에 창이 안 뜸). 시연·녹화 때만 `JG_SHOW_BROWSER=1` 로 보이게 연다 — 그건 오케스트레이터가 한다.
- 🔴 시험할 때 `JG_SHOW_BROWSER=1` 을 켜지 마라. 브라우저 창을 화면에 띄우는 시험은 하지 않는다.

## 🔁 변경 공지 — 브라우저는 크롬 전용 프로필(Playwright)로 바뀜

- 사용자 결정: 다른 사람 PC 에서도 돌고 과제 문구("크롬 프로필 유튜브1")에 맞게 **Aside 대신 Google Chrome 전용 프로필**을 쓴다.
- 새 부품 `src/browser.mjs`(playwright-core `launchPersistentContext` + `channel:'chrome'`). `cdp.mjs` 와 **같은 모양**:
  `connect({ profile })` — profile 은 `config.profiles` 항목(예: `cfg.profiles[0]`). 포트 대신 프로필을 넘긴다.
  page 에 `raw`(Playwright Page) · `onCdp(event, fn)`(CDP 이벤트) 가 더 있다. 서버를 끌 때 `closeAll()`.
- 프로필 '유튜브1' 은 로그인 확인 완료(`tools/check-login.mjs` → loggedIn:true, hl:ko).
- 🔴 같은 프로필은 **한 프로세스만** 열 수 있다. 서버 안에서는 collect·post 가 같은 크롬을 공유하므로 괜찮지만,
  시험 스크립트를 서버와 **동시에** 따로 돌리면 "이미 열려 있음" 오류가 난다 — 순서대로 돌린다.
- 구현 담당: `cdp.mjs`(Aside) 로 만들고 시험했어도 된다. **통합 점검 담당이 collect·post 의 import 를 `browser.mjs` 로 바꾸고 `connect({ profile })` 로 맞춘 뒤 다시 시험한다.** Aside 는 더 쓰지 않는다.

## 공용 (오케스트레이터 소유 — 담당은 고치지 말고 필요하면 보고)

- `src/config.mjs` — `loadConfig()`, `ROOT`, `DATA_DIR`(= `data/`, git 제외). `.env` 를 읽어 `process.env` 에 넣는다.
- `src/feed.mjs` — `fetchLatestVideos(channels) → { videos: Video[], errors }` (RSS, 실측 75개 OK)
- `src/cdp.mjs` — Aside 브라우저 조종. `connect({port})` →
  `newWindow(url)`(보이는 새 창) · `newBackgroundWindow(url)`(뒤쪽 새 창) · `disconnect()`(만든 창 닫고 연결만 끊음).
  page: `evaluate(fn,...args)` · `waitFor(fn,{timeout,args,what})` · `goto(url)` · `click(selector)` · `typeText(text,{delayMs,onChar})` · `screenshot(path)` · `bringToFront()` · `close()` · `send(method,params)`(원시 CDP)
- `config.json` — channels(5) · testVideos(본인 테스트 영상 videoId, 지금 비어 있음) · comment{minChars,maxChars,brand} · limits{dailyMaxComments} · typing{delayMs} · ai{provider} · profiles[0].cdpPort=9223

```js
// Video (feed.mjs)
{ videoId, title, channelId, channelName, publishedAt, thumbnail, views, url }
```

## 담당별 파일 (자기 파일만 만든다 — 남의 파일 수정 금지)

| 담당 | 만들 파일 |
|---|---|
| 수집 | `src/collect.mjs`, `tools/test-collect.mjs` |
| 게시 | `src/post.mjs`, `tools/test-post.mjs` |
| AI | `src/ai.mjs`, `src/validate.mjs`, `tools/test-ai.mjs` |
| 화면·규칙 | `src/server.mjs`, `src/rules.mjs`, `public/index.html`, `public/app.js`, `public/style.css`, `tools/test-rules.mjs` |

## 수집 — `src/collect.mjs`

```js
export async function getVideoMeta(videoId) // → { videoId, title, channelId, channelName, description, publishedAt, isLive }
export async function collectVideoContext(videoId, { onStatus } = {}) // → VideoContext
```

```js
// VideoContext
{
  videoId, title, channelId, channelName, description,
  transcript: { status: 'ok' | 'none' | 'failed', lang, text, segments: [{ t: 초, text }], error },
  topComments: [{ author, text, likes }],   // 기본(인기순) 상위 최대 20
  collectedAt                                 // ISO
}
```
- `status:'none'` = 영상에 자막이 정말 없음. `'failed'` = 있는데 못 가져옴. 둘을 섞지 않는다.
- Aside 의 **뒤쪽 새 창**(`newBackgroundWindow`)에서 읽고 반드시 닫는다.

## 게시 — `src/post.mjs`

```js
export async function postComment({ videoId, text, dryRun = true, delayMs, onStatus }) // → PostResult
// onStatus(stage, detail) — stage: 'opening' | 'loading' | 'typing' | 'posting' | 'verifying' | 'done' | 'failed'
//   typing 의 detail = { typed, total }
// PostResult
{ ok, stage, dryRun, verified, commentText, authorName, screenshot, error }
```
- **보이는 새 창**(`newWindow`) + `bringToFront()` — 시연 영상에 열리는 장면·타이핑이 보여야 한다.
- 한 글자씩 `typeText`. 게시 후 **내 댓글이 보이는지 확인**(작성자 + 본문 비교). 실패하면 `data/captures/<시각>_<videoId>.png` 캡처 + 이유.
- 확인이 끝나면 창은 **열어 둔다**(시연에서 내 댓글을 보여주려고) — `disconnect({ keepOpen:[page.targetId] })`.

## AI — `src/ai.mjs`, `src/validate.mjs`

```js
export async function generateDraft(ctx /* VideoContext */, { brand, minChars, maxChars }) // → Draft
// Draft
{ worry, comment, evidence: [{ source: 'transcript' | 'description' | 'title' | 'comment', quote, t }], provider, attempts, checks }
export function validateComment(text, ctx, { brand, minChars, maxChars }) // → { ok, errors: [문자열] }
```
- 공급자: `ANTHROPIC_API_KEY` 가 있으면 Messages API, 없으면 이 PC 의 `claude -p` CLI.
- 과제 규칙: 40~120자 · 영상 속 구체적 장면/말 하나 이상 · 영상마다 다르게 · 링크·해시태그 금지 · 운명원을 써 본 것처럼 지어낸 후기 금지 · 시청자 페르소나로 운명원 연애 사주를 보고 싶게.

## 화면·규칙 — `src/server.mjs`, `src/rules.mjs`, `public/*`

- `node src/server.mjs` → `http://127.0.0.1:4310`. 세 칸: ① 영상 불러오기 ② 영상 선택(목록 + 링크 직접 입력) → 고민 한 줄·초안(수정 가능) ③ 댓글 달기 → 진행 상태 실시간 표시 · 기록 표.
- API: `GET /api/videos` · `POST /api/draft {videoId|url}` · `POST /api/post {videoId,text,profileId}` · `GET /api/events`(SSE) · `GET /api/log` · `GET /api/config`
- 규칙(코드로 강제, 서버 쪽): 허용 = 지정 5채널 영상 또는 `testVideos` · 영상당 1개(성공·결과불명 모두 잠금) · 하루 상한(앱 전체, PC 로컬 날짜) · 시간순 기록 `data/log.json`(어느 영상·어느 프로필·무슨 댓글·성공/실패·이유).
- 다른 담당 모듈이 아직 없을 수 있다 — 계약 모양대로 import 하되 시험은 가짜(stub)로.

## 🔴 안전 규칙 (모든 담당)

1. **실제 게시 금지.** `dryRun:false` 로 실행하지 않는다. 게시 시험은 사용자 테스트 영상이 정해진 뒤 오케스트레이터가 한다.
2. Aside 의 **기존 탭(사용자·다른 세션 탭)에 붙거나 닫지 않는다.** `cdp.mjs` 가 만든 창만 쓴다. `Browser.close` 같은 브라우저 전체 명령 금지.
3. 비밀값(키·쿠키·토큰)을 출력·저장·로그하지 않는다.
4. `npm install` 등 패키지 설치 금지(내장만). git 명령(commit·checkout·reset 등) 금지.
5. `개인문서/`·`기타파일/`·`jg_test` 밖 파일은 열지도 고치지도 않는다(과제 PDF 제외).
