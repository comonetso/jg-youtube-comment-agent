// 수집 담당 — 영상 하나의 정보·자막·인기 댓글을 뒤쪽 새 창에서 읽는다. 읽기 전용.
//
// 브라우저: 크롬 전용 프로필(browser.mjs, 기본 config.profiles[0]). 2026-10-19 통합 점검 때 cdp.mjs(Aside)에서 바꿨다
//   (contracts.md 변경 공지). 다른 연결을 쓰려면 옵션 { connect, profile } 으로 넘긴다.
//
// 자막을 어떻게 가져오나 (2026-10-19 Aside 실측. 1차 탐색 스크립트(data/_probe)는 data 정리 때 지워졌고,
//   2차(data/collect-test/probe-player.mjs·probe-retry.mjs)는 남아 있다. 결과 전체는 수집 담당 보고에 있다):
//   - 자막 주소(baseUrl)를 페이지 밖에서든 페이지 안에서든 그대로 받으면 본문 0바이트 → 못 씀.
//   - 내부 API(get_transcript)를 직접 부르면 400 "Precondition check failed" → 못 씀.
//   - 플레이어에게 자막을 켜게 하면, 플레이어가 보안값(pot)을 붙여 json3 자막을 받는다 → 그 응답을 페이지 안에서 복사(1순위).
//     · 플레이어 준비 직후 바로 켜면 응답이 0바이트였다(2/2). 1.5초 뒤 켜면 정상(2/2). → 댓글을 먼저 읽고 그 뒤에 켠다.
//     · 0바이트가 오면 자막을 껐다가 다시 켜면 재요청이 나가 정상으로 받았다(1/1). → 한 번 다시 켠다.
//     · 재생을 막아 둔 상태(플레이어 상태 -1)에서도 요청이 나간다.
//   - 복사가 안 잡히면 브라우저 요청 기록의 같은 주소를 페이지 안에서 다시 받는다(2순위). 기록 칸이 기본 250개라
//     유튜브에선 가득 차 비어 보였다 → PRELOAD 에서 기록 칸을 늘린다.
//   - 설명란의 "스크립트 표시" 패널을 element.click() 으로 열어 DOM 을 읽는다(3순위, 뒤쪽 창에서도 열림. 1/4 영상은 패널이 비었다).
//
// 이 창에서만 적용되는 것(페이지보다 먼저 넣는 스크립트, PRELOAD):
//   - 영상 재생을 막는다 → 소리가 나지 않고 영상 데이터도 받지 않는다.
//   - 유튜브 자막 설정(localStorage 의 yt-player-caption-*) 저장을 막는다 → 자막을 켜도 브라우저의 유튜브 자막 설정이 바뀌지 않는다.
//     (막지 않으면 '자막 켜짐 유지=true · 언어=ko' 가 저장되는 것을 실측했다)
//   - 플레이어가 받은 자막 응답(/api/timedtext)을 복사해 둔다.
import { connect as browserConnect } from './browser.mjs';
import { loadConfig } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** 근거 없이 정한 대기 값·개수 — 전부 여기 모은다(보고서 decisions 에 같은 값). */
export const COLLECT_LIMITS = {
  metaTimeoutMs: 20000, //        영상 정보(ytInitialPlayerResponse)가 나타날 때까지
  playerTimeoutMs: 10000, //      플레이어(movie_player)가 자막 명령을 받을 준비가 될 때까지
  transcriptWaitMs: 5000, //      자막을 켠 뒤 응답 복사본을 기다리는 시간 (없으면 한 번 끄고 다시 켠다)
  transcriptRetryWaitMs: 8000, // 다시 켠 뒤 응답 복사본을 기다리는 시간
  captionRetryGapMs: 300, //      자막을 끈 뒤 다시 켜기까지 (실측에 쓴 값)
  panelTimeoutMs: 15000, //       "스크립트 표시" 패널 줄이 나타날 때까지
  panelSettleMs: 500, //          패널 줄 개수가 이 간격으로 두 번 같으면 다 붙은 것으로 본다
  commentsMax: 20, //             계약: 인기순 상위 최대 20
  commentsFirstTimeoutMs: 15000, // 첫 댓글(또는 꺼짐 안내)이 나타날 때까지
  commentsTotalTimeoutMs: 25000, // 댓글 읽기 전체 상한
  commentsIdleMs: 1500, //        더 불러올 것(continuation)이 없고 개수가 이만큼 그대로면 끝
  commentsStepMs: 400, //         스크롤 한 번 뒤 기다리는 시간
};

export const COLLECT_PRELOAD = `(() => {
  if (window.__jgCollect) return;
  const box = (window.__jgCollect = { timedtext: [] });
  try { performance.setResourceTimingBufferSize(5000); } catch (e) {}
  // 재생은 막지 않고 소리만 끈다(수집 창에서 소리가 나지 않게). 자막이 비던 원인은 재생 차단이 아니라
  // 크롬의 자동 조종 표시였다 — browser.mjs chromeArgs 의 hideAutomation 참고.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try { this.muted = true; } catch (e) {}
    return origPlay.apply(this, arguments);
  };
  const blocked = (k) => /^yt-player-caption/.test(String(k));
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    if (this === window.localStorage && blocked(k)) return;
    return setItem.apply(this, arguments);
  };
  Storage.prototype.removeItem = function (k) {
    if (this === window.localStorage && blocked(k)) return;
    return removeItem.apply(this, arguments);
  };
  const keep = (via, url, body) => { try { box.timedtext.push({ via, url: String(url), body: String(body || '') }); } catch (e) {} };
  const isTimedtext = (u) => typeof u === 'string' && u.indexOf('/api/timedtext') !== -1;
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(window, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isTimedtext(url)) p.then((r) => r.clone().text()).then((t) => keep('fetch', url, t)).catch(() => {});
    } catch (e) {}
    return p;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const u = String(url);
      if (isTimedtext(u)) this.addEventListener('load', () => { try { keep('xhr', u, this.responseText); } catch (e) {} });
    } catch (e) {}
    return open.apply(this, arguments);
  };
})();`;

// ───────────────────────── 페이지 안에서 실행되는 함수들 (자기완결이어야 한다) ─────────────────────────

function pageReadPlayerResponse() {
  const pr = window.ytInitialPlayerResponse;
  if (!pr) return null;
  const vd = pr.videoDetails;
  const mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
  const tl = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
  const ps = pr.playabilityStatus || {};
  const text = (o) => (o ? o.simpleText || (o.runs || []).map((r) => r.text).join('') : '');
  return {
    playability: { status: ps.status || null, reason: ps.reason || text(ps.errorScreen?.playerErrorMessageRenderer?.reason) || null },
    meta: vd
      ? {
          videoId: vd.videoId,
          title: vd.title || '',
          channelId: vd.channelId || '',
          channelName: vd.author || '',
          description: vd.shortDescription || '',
          publishedAt: (mf && (mf.publishDate || mf.uploadDate)) || null,
          isLive: !!vd.isLiveContent,
        }
      : null,
    tracks: ((tl && tl.captionTracks) || []).map((t) => ({ languageCode: t.languageCode, kind: t.kind || '', name: text(t.name) })),
  };
}

function pagePlayerReady() {
  const mp = document.getElementById('movie_player');
  return !!(mp && typeof mp.setOption === 'function');
}

function pageRequestCaptions(track) {
  const mp = document.getElementById('movie_player');
  if (!mp || typeof mp.setOption !== 'function') return { ok: false, error: '플레이어를 찾지 못했습니다' };
  try { mp.loadModule && mp.loadModule('captions'); } catch (e) {}
  try {
    mp.setOption('captions', 'track', track.kind === 'asr' ? { languageCode: track.languageCode, kind: 'asr' } : { languageCode: track.languageCode });
  } catch (e) {
    return { ok: false, error: `플레이어 자막 켜기 실패: ${e && e.message}` };
  }
  return { ok: true };
}

/** 빈 응답이 왔을 때: 자막을 껐다가 다시 켜서 재요청을 낸다. */
async function pageRetryCaptions(track, gapMs) {
  const mp = document.getElementById('movie_player');
  if (!mp || typeof mp.setOption !== 'function') return { ok: false, error: '플레이어를 찾지 못했습니다' };
  try {
    mp.setOption('captions', 'track', {});
    await new Promise((r) => setTimeout(r, gapMs));
    mp.setOption('captions', 'track', track.kind === 'asr' ? { languageCode: track.languageCode, kind: 'asr' } : { languageCode: track.languageCode });
  } catch (e) {
    return { ok: false, error: `플레이어 자막 다시 켜기 실패: ${e && e.message}` };
  }
  return { ok: true };
}

/** 진단용: 지금까지 복사된 자막 응답 수와 그중 빈 응답 수 */
function pageTimedtextStats() {
  const list = (window.__jgCollect && window.__jgCollect.timedtext) || [];
  return { total: list.length, empty: list.filter((x) => !x.body).length };
}

/** 플레이어가 받은 자막 응답 복사본 중 이 영상·이 언어의 것을 꺼낸다. */
function pageTakeTimedtext(videoId, lang) {
  const info = (u) => {
    try {
      const p = new URL(u, location.href).searchParams;
      return { v: p.get('v'), lang: p.get('lang'), tlang: p.get('tlang'), kind: p.get('kind') || '', fmt: p.get('fmt') || '' };
    } catch (e) { return null; }
  };
  const list = (window.__jgCollect && window.__jgCollect.timedtext) || [];
  for (const x of list) {
    const i = info(x.url);
    if (i && i.v === videoId && i.lang === lang && !i.tlang && x.body) return { via: x.via, kind: i.kind, fmt: i.fmt, body: x.body };
  }
  return null;
}

/** 복사본이 없을 때: 브라우저가 이미 요청한 자막 주소(보안값 포함)를 페이지 안에서 다시 받는다. */
async function pageRefetchTimedtext(videoId, lang) {
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.indexOf('/api/timedtext') !== -1);
  const tried = [];
  for (const u of urls.reverse()) {
    let p;
    try { p = new URL(u).searchParams; } catch (e) { continue; }
    if (p.get('v') !== videoId || p.get('lang') !== lang || p.get('tlang')) continue;
    try {
      const r = await fetch(u, { credentials: 'include' });
      const body = await r.text();
      tried.push(`${r.status}/${body.length}B`);
      if (body) return { via: 'refetch', kind: p.get('kind') || '', fmt: p.get('fmt') || '', body };
    } catch (e) { tried.push(String(e && e.message)); }
  }
  return { none: true, seen: urls.length, tried };
}

/** 설명란의 "스크립트 표시" 패널을 열어 줄을 읽는다. */
async function pageReadTranscriptPanel(timeoutMs, settleMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const expand = document.querySelector('#description-inline-expander #expand, ytd-text-inline-expander #expand');
  if (expand) { try { expand.click(); } catch (e) {} await sleep(300); }
  const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
  if (!btn) return { ok: false, error: '설명란에 "스크립트 표시" 버튼이 없습니다' };
  btn.click();
  const end = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < end) {
    n = document.querySelectorAll('ytd-transcript-segment-renderer').length;
    if (n) break;
    await sleep(250);
  }
  if (!n) {
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]');
    const msg = panel && panel.innerText ? panel.innerText.replace(/\s+/g, ' ').trim().slice(0, 150) : '';
    return { ok: false, error: `스크립트 패널에 줄이 나타나지 않았습니다${msg ? ` (패널 글: ${msg})` : ''}` };
  }
  for (let i = 0; i < 20; i++) {
    await sleep(settleMs);
    const m = document.querySelectorAll('ytd-transcript-segment-renderer').length;
    if (m === n) break;
    n = m;
  }
  const footer = document.querySelector('ytd-transcript-footer-renderer');
  return {
    ok: true,
    footer: footer ? footer.innerText.replace(/\s+/g, ' ').trim() : '',
    rows: [...document.querySelectorAll('ytd-transcript-segment-renderer')].map((s) => ({
      ts: (s.querySelector('.segment-timestamp')?.textContent || '').trim(),
      text: (s.querySelector('.segment-text')?.textContent || '').trim(),
    })),
  };
}

/** 댓글 영역으로 스크롤해 인기순 상위 댓글을 읽는다. 정렬은 바꾸지 않는다(기본 = 인기순). */
async function pageReadComments(o) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const root = () => document.querySelector('ytd-comments#comments');
  const threads = () => document.querySelectorAll('ytd-comments#comments ytd-comment-thread-renderer');
  const contItem = () => document.querySelector('ytd-comments#comments #sections > #contents > ytd-continuation-item-renderer');
  const messageText = () => {
    const m = document.querySelector('ytd-comments#comments ytd-message-renderer');
    return m && m.innerText ? m.innerText.replace(/\s+/g, ' ').trim() : '';
  };
  let lastN = -1;
  let lastChange = Date.now();
  let status = null;
  let reason = null;
  const vis = new Set();
  while (true) {
    vis.add(document.visibilityState);
    const c = root();
    const cont = contItem();
    if (cont) cont.scrollIntoView({ block: 'end' });
    else if (c) { c.scrollIntoView({ block: 'start' }); window.scrollBy(0, 400); }
    else window.scrollBy(0, 600);
    await sleep(o.stepMs);

    const n = threads().length;
    if (n !== lastN) { lastN = n; lastChange = Date.now(); }
    const elapsed = Date.now() - t0;
    if (n >= o.max) { status = 'ok'; break; }
    if (n === 0) {
      const msg = messageText();
      if (msg) { status = 'disabled'; reason = msg; break; }
      const countText = (document.querySelector('ytd-comments-header-renderer #count')?.innerText || '').trim();
      if (/^댓글\s*0\s*개$/.test(countText) && !contItem()) { status = 'empty'; reason = '댓글이 0개입니다'; break; }
      if (elapsed > o.firstTimeoutMs) {
        status = 'failed';
        reason = `${Math.round(o.firstTimeoutMs / 1000)}초 안에 댓글이 나타나지 않았습니다 (댓글 영역 ${c ? '있음' : '없음'}, 불러오기 표시 ${contItem() ? '있음' : '없음'}, 창 상태 ${[...vis].join('/')})`;
        break;
      }
      continue;
    }
    if (!contItem() && Date.now() - lastChange >= o.idleMs) { status = 'ok'; break; }
    if (elapsed > o.totalTimeoutMs) {
      status = 'ok';
      reason = `${Math.round(o.totalTimeoutMs / 1000)}초 안에 ${n}개까지만 불러왔습니다 (창 상태 ${[...vis].join('/')})`;
      break;
    }
  }
  const sortMenu = document.querySelector('ytd-comments-header-renderer #sort-menu');
  const selected = sortMenu && [...sortMenu.querySelectorAll('a')].find((a) => a.classList.contains('iron-selected'));
  return {
    status,
    reason,
    ms: Date.now() - t0,
    countText: (document.querySelector('ytd-comments-header-renderer #count')?.innerText || '').trim() || null,
    sort: selected ? (selected.textContent || '').replace(/\s+/g, ' ').trim() || null : null,
    rows: [...threads()].slice(0, o.max).map((t) => {
      const cm = t.querySelector('#comment') || t;
      return {
        author: (cm.querySelector('#author-text')?.textContent || '').trim(),
        text: (cm.querySelector('#content-text')?.textContent || '').trim(),
        likeAria: cm.querySelector('#like-button button')?.getAttribute('aria-label') || '',
        likeShort: (cm.querySelector('#vote-count-middle')?.textContent || '').trim(),
        pinned: !!cm.querySelector('#pinned-comment-badge > *'),
      };
    }),
  };
}

/** 시험용: 페이지로 보내는 함수들 — 브라우저 없이 문자열로 바꿔 문법만 점검할 수 있게 내보낸다. */
export const COLLECT_PAGE_FUNCTIONS = [
  pageReadPlayerResponse,
  pagePlayerReady,
  pageRequestCaptions,
  pageRetryCaptions,
  pageTimedtextStats,
  pageTakeTimedtext,
  pageRefetchTimedtext,
  pageReadTranscriptPanel,
  pageReadComments,
];

// ───────────────────────── Node 쪽 해석 ─────────────────────────

const round2 = (x) => Math.round(x * 100) / 100;

/** json3 자막 → [{ t: 초, text }] */
export function parseJson3(body) {
  const j = JSON.parse(body);
  const out = [];
  for (const ev of j.events || []) {
    if (!Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ t: round2((ev.tStartMs || 0) / 1000), text });
  }
  return out;
}

/** "1:02:03" / "13:23" → 초 */
export function hmsToSeconds(s) {
  const parts = String(s).trim().split(':').map((x) => Number(x));
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

/** "1,234" · "1.2천" · "3만" · "1.5K" → 숫자. 못 읽으면 null */
export function parseCount(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(천|만|억|[KMB])?/i);
  if (!m) return null;
  const mult = { 천: 1e3, 만: 1e4, 억: 1e8, k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** 좋아요 수: 버튼 설명 글("나와 사용자 24명이 이 댓글을 좋아함")이 정확한 수 → 없으면 화면 약식 표기 → 둘 다 없으면 0 */
export function parseLikes(aria, short) {
  const a = aria && String(aria).match(/사용자\s*([\d.,]+\s*(?:천|만|억)?)\s*명/);
  if (a) { const n = parseCount(a[1]); if (n != null) return n; }
  return parseCount(short) ?? 0;
}

/** 한국어 우선(사람이 단 자막 > 자동 자막), 없으면 다른 언어(사람이 단 자막 > 자동 자막, 목록 순서) */
export function pickTrack(tracks) {
  const ko = tracks.filter((t) => t.languageCode === 'ko' || t.languageCode.startsWith('ko-'));
  return ko.find((t) => t.kind !== 'asr') || ko[0] || tracks.find((t) => t.kind !== 'asr') || tracks[0] || null;
}

// ───────────────────────── 공통: 창 열기 ─────────────────────────

/**
 * 브라우저 연결. connect 를 넘기면 그것을 쓰고, 안 넘기면 browser.mjs(크롬 전용 프로필).
 * profile 을 안 넘기면 config.profiles[0].
 */
async function openBrowser({ connect, profile, port, mode } = {}) {
  let cfg;
  try { cfg = loadConfig(); } catch {}
  // 영상 읽기는 로그인이 필요 없어 게시용 프로필과 따로 쓴다(config.collector) — 같은 프로필을 읽기·게시가
  // 번갈아 닫고 열면 잠금이 겹쳐 멈추거나 로그인이 안 읽혔다(2026-10-19 실측). 없으면 게시용 첫 프로필.
  const collector = cfg?.collector;
  const useProfile = profile || collector || cfg?.profiles?.[0];
  const useMode = mode || collector?.mode || 'headless';
  return (connect || browserConnect)({ profile: useProfile, port, mode: useMode });
}

function checkVideoId(videoId) {
  if (!VIDEO_ID_RE.test(String(videoId || ''))) throw new Error(`영상 ID 형식이 아닙니다: ${String(videoId).slice(0, 40)}`);
}

/** 뒤쪽 새 창을 열고 PRELOAD 를 넣은 뒤 영상 페이지로 간다. 영상 정보까지 읽어 돌려준다. */
async function openWatch(browser, videoId) {
  const page = await browser.newBackgroundWindow(null);
  if (page.raw && typeof page.raw.addInitScript === 'function') await page.raw.addInitScript({ content: COLLECT_PRELOAD }); // browser.mjs(Playwright)
  else await page.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECT_PRELOAD }); // cdp.mjs
  await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=ko`);
  const pr = await page.waitFor(pageReadPlayerResponse, { timeout: COLLECT_LIMITS.metaTimeoutMs, what: '영상 정보(ytInitialPlayerResponse)' });
  if (!pr.meta) {
    const why = [pr.playability.status, pr.playability.reason].filter(Boolean).join(' · ');
    throw new Error(`영상을 열 수 없습니다${why ? ` (${why})` : ''}`);
  }
  if (pr.meta.videoId !== videoId) throw new Error(`다른 영상 정보가 읽혔습니다 (${pr.meta.videoId})`);
  return { page, pr };
}

// ───────────────────────── 계약 함수 ─────────────────────────

/** 가벼운 영상 정보 — 링크 직접 입력 때 채널 검사용. 옵션 { connect, profile, port } 는 openBrowser 참고. */
export async function getVideoMeta(videoId, opts = {}) {
  checkVideoId(videoId);
  const browser = await openBrowser(opts);
  try {
    const { pr } = await openWatch(browser, videoId);
    return pr.meta;
  } finally {
    await browser.disconnect();
  }
}

/**
 * 영상 하나의 맥락(정보·자막·인기 댓글)을 모은다.
 * onStatus(stage, detail) — stage: 'opening' | 'meta' | 'comments' | 'transcript' | 'done' | 'failed'
 *   comments·transcript 는 두 번 온다: detail.phase = 'start' → 'end'
 */
export async function collectVideoContext(videoId, { onStatus, ...opts } = {}) {
  const status = (stage, detail) => { try { onStatus?.(stage, detail); } catch {} };
  checkVideoId(videoId);
  status('opening', { videoId });
  let browser;
  try {
    browser = await openBrowser(opts);
    const { page, pr } = await openWatch(browser, videoId);
    const meta = pr.meta;
    status('meta', { title: meta.title, channelName: meta.channelName, tracks: pr.tracks.length });
    const track = pickTrack(pr.tracks);

    // 1) 댓글 — 페이지를 연 직후(창이 보이는 동안) 먼저 읽는다. 그동안 플레이어의 자막 보안값이 준비된다.
    status('comments', { phase: 'start' });
    let comments;
    try {
      const r = await page.evaluate(pageReadComments, {
        max: COLLECT_LIMITS.commentsMax,
        firstTimeoutMs: COLLECT_LIMITS.commentsFirstTimeoutMs,
        totalTimeoutMs: COLLECT_LIMITS.commentsTotalTimeoutMs,
        idleMs: COLLECT_LIMITS.commentsIdleMs,
        stepMs: COLLECT_LIMITS.commentsStepMs,
      });
      const all = r.rows.map((x) => ({ author: x.author, text: x.text, likes: parseLikes(x.likeAria, x.likeShort), pinned: x.pinned }));
      const list = all.filter((x) => x.author && x.text); // 본문이 비어 읽히는 댓글(이모지 그림만 등)은 뺀다
      comments = {
        status: r.status,
        reason: r.reason,
        countText: r.countText,
        sort: r.sort,
        droppedEmpty: all.length - list.length,
        list,
      };
    } catch (e) {
      comments = { status: 'failed', reason: `댓글 읽기 오류: ${e.message}`, countText: null, sort: null, droppedEmpty: 0, list: [] };
    }
    status('comments', { phase: 'end', count: comments.list.length, status: comments.status });

    // 2) 자막 — 이제 플레이어에게 자막을 켜게 하고 응답을 회수한다
    status('transcript', { phase: 'start', lang: track?.languageCode || null });
    const transcript = await readTranscript(page, videoId, pr, track);
    status('transcript', { phase: 'end', status: transcript.status, chars: transcript.text.length });

    const ctx = {
      videoId,
      title: meta.title,
      channelId: meta.channelId,
      channelName: meta.channelName,
      description: meta.description,
      publishedAt: meta.publishedAt,
      isLive: meta.isLive,
      transcript,
      topComments: comments.list,
      comments: { status: comments.status, reason: comments.reason, countText: comments.countText, sort: comments.sort, droppedEmpty: comments.droppedEmpty },
      collectedAt: new Date().toISOString(),
    };
    status('done', { transcript: transcript.status, comments: comments.list.length });
    return ctx;
  } catch (e) {
    status('failed', { error: e.message });
    throw e;
  } finally {
    if (browser) await browser.disconnect();
  }
}

async function readTranscript(page, videoId, pr, track) {
  const steps = [];
  const empty = { lang: null, kind: null, source: null, text: '', segments: [] };
  if (!track) {
    if (pr.playability.status && pr.playability.status !== 'OK') {
      const why = [pr.playability.status, pr.playability.reason].filter(Boolean).join(' · ');
      return { status: 'failed', ...empty, error: `재생할 수 없는 상태라 자막 목록을 확인하지 못했습니다 (${why})` };
    }
    return { status: 'none', ...empty, error: null };
  }
  const ok = (segments, extra) => ({
    status: 'ok',
    ...extra,
    text: segments.map((s) => s.text).join(' '),
    segments,
    error: null,
  });

  // 1순위: 플레이어에게 자막을 켜게 하고 응답 복사본을 꺼낸다. 없으면(빈 응답 등) 한 번 끄고 다시 켠다.
  const take = (timeout) =>
    page.waitFor(pageTakeTimedtext, { timeout, args: [videoId, track.languageCode], what: '플레이어 자막 응답' }).catch(() => null);
  let got = null;
  try {
    await page.waitFor(pagePlayerReady, { timeout: COLLECT_LIMITS.playerTimeoutMs, what: '플레이어 준비' });
    const r = await page.evaluate(pageRequestCaptions, track);
    if (!r.ok) steps.push(r.error);
    else {
      got = await take(COLLECT_LIMITS.transcriptWaitMs);
      if (!got) {
        const s1 = await page.evaluate(pageTimedtextStats).catch(() => null);
        const r2 = await page.evaluate(pageRetryCaptions, track, COLLECT_LIMITS.captionRetryGapMs);
        if (!r2.ok) steps.push(r2.error);
        else got = await take(COLLECT_LIMITS.transcriptRetryWaitMs);
        if (!got) {
          const s2 = await page.evaluate(pageTimedtextStats).catch(() => null);
          steps.push(`플레이어 자막 응답을 받지 못했습니다 (켜기 뒤 응답 ${s1?.total ?? '?'}건·빈 응답 ${s1?.empty ?? '?'}건 → 다시 켠 뒤 응답 ${s2?.total ?? '?'}건·빈 응답 ${s2?.empty ?? '?'}건)`);
        }
      }
    }
  } catch (e) {
    steps.push(e.message);
  }
  // 2순위: 브라우저 요청 기록의 같은 주소를 페이지 안에서 다시 받는다
  if (!got) {
    try {
      const r = await page.evaluate(pageRefetchTimedtext, videoId, track.languageCode);
      if (r && !r.none) got = r;
      else steps.push(`자막 주소 다시 받기 실패 (요청 기록 ${r?.seen ?? 0}건${r?.tried?.length ? `, ${r.tried.join(', ')}` : ''})`);
    } catch (e2) {
      steps.push(`자막 주소 다시 받기 오류: ${e2.message}`);
    }
  }
  if (got) {
    try {
      const segments = parseJson3(got.body);
      if (segments.length) {
        return ok(segments, { lang: track.languageCode, kind: got.kind === 'asr' ? 'asr' : 'manual', source: `player-${got.via}` });
      }
      steps.push('플레이어 자막 응답에 줄이 없습니다');
    } catch (e) {
      steps.push(`플레이어 자막 응답 해석 실패 (fmt=${got.fmt || '?'}, ${e.message})`);
    }
  }

  // 3순위: 스크립트 표시 패널
  try {
    const r = await page.evaluate(pageReadTranscriptPanel, COLLECT_LIMITS.panelTimeoutMs, COLLECT_LIMITS.panelSettleMs);
    if (r.ok) {
      // 화면에 스크립트 목록이 두 군데 그려져 같은 줄이 두 벌 읽힌 적이 있다(c-QzU4kuu90: 344줄 × 2) → 같은 시각·본문은 한 번만
      const seen = new Set();
      const segments = r.rows
        .map((x) => ({ t: hmsToSeconds(x.ts), text: x.text.replace(/\s+/g, ' ').trim() }))
        .filter((x) => x.text && x.t != null)
        .filter((x) => { const k = `${x.t}|${x.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
      if (segments.length) {
        const byName =
          pr.tracks.find((t) => t.name && t.name === r.footer) ||
          pr.tracks.find((t) => t.name && r.footer && r.footer.includes(t.name));
        return ok(segments, {
          lang: byName?.languageCode || null,
          kind: byName ? (byName.kind === 'asr' ? 'asr' : 'manual') : null,
          source: 'panel',
          panelLabel: r.footer || null,
        });
      }
      steps.push('스크립트 패널 줄에서 시각·본문을 읽지 못했습니다');
    } else {
      steps.push(r.error);
    }
  } catch (e) {
    steps.push(`스크립트 패널 오류: ${e.message}`);
  }
  return { status: 'failed', ...empty, error: steps.join(' / ') || '알 수 없는 이유' };
}
