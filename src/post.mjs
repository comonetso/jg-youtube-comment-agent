// 게시 담당 — Aside 의 보이는 새 창에서 유튜브 댓글을 한 글자씩 타이핑하고(게시 시) 내 댓글을 확인한다.
// 계약: docs/contracts.md "게시 — src/post.mjs"
//
// 안전 원칙
// - dryRun 은 `dryRun === false` 로 명시했을 때만 게시 경로로 간다. 그 밖의 값은 전부 시험(입력 후 비우고 취소).
// - 키 입력은 Input.insertText(한 글자씩)만 쓴다. Enter·Ctrl+Enter 키 이벤트는 보내지 않는다.
//   줄바꿈이 든 글은 입력 단계에서 줄바꿈으로 처리될 수 있어 아예 입력하지 않는다.
// - browser.mjs(크롬 전용 프로필)로 이 부품이 연 창만 다룬다.
//
// 화면 구조(2026-10-19 Aside·한국어 화면에서 실측, data/_probe 탐침):
// - 입력 상자: #simplebox-placeholder (문구 "댓글 추가...", role=textbox) → 누르면 편집칸이 열리고 초점이 들어간다
// - 편집칸: ytd-commentbox #contenteditable-root (contenteditable=true)
// - 제출: ytd-commentbox #buttons ytd-button-renderer#submit-button button (aria-label "댓글", 비어 있으면 disabled)
// - 취소: ytd-commentbox #buttons ytd-button-renderer#cancel-button button (aria-label "취소")
//   ※ '#cancel-button' 만 쓰면 크기 0 인 다른 요소(첨부 영역)가 먼저 잡힌다 — 반드시 #buttons 아래로 좁힌다
// - 댓글 목록: ytd-comment-thread-renderer, 작성자 #author-text(핸들 "@..."), 본문 #content-text
// - 내 계정: /getAccountSwitcherEndpoint 응답에서 isSelected 인 계정의 이름·핸들(같은 출처 요청, 페이지 쿠키 사용 — 값은 출력하지 않음)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from './browser.mjs'; // 2026-10-19 통합 점검: cdp.mjs(Aside) → 크롬 전용 프로필(contracts.md 변경 공지)
import { loadConfig, DATA_DIR } from './config.mjs';

const SEL = {
  comments: 'ytd-comments#comments',
  placeholder: 'ytd-comments#comments #simplebox-placeholder',
  commentbox: 'ytd-comments#comments ytd-commentbox',
  editor: 'ytd-comments#comments ytd-commentbox #contenteditable-root',
  submit: 'ytd-comments#comments ytd-commentbox #buttons ytd-button-renderer#submit-button button',
  cancel: 'ytd-comments#comments ytd-commentbox #buttons ytd-button-renderer#cancel-button button',
  thread: 'ytd-comments#comments ytd-comment-thread-renderer',
  disabledMsg: 'ytd-comments#comments ytd-message-renderer',
};

// 대기 상한(ms) — 근거 없이 정한 값. 실측(로드 2.7초, 댓글 상자 2.7초)보다 넉넉하게 잡았다.
const T = {
  player: 30000, // 영상 정보(ytInitialPlayerResponse) 뜰 때까지
  comments: 30000, // 댓글 영역의 "댓글 추가..." 상자가 생길 때까지
  focus: 10000, // 편집칸에 초점이 들어갈 때까지
  clear: 5000, // 비운 뒤 제출 버튼이 다시 꺼질 때까지
  close: 5000, // 취소 뒤 상자가 닫힐 때까지
  submitEnabled: 10000, // 제출 버튼이 켜질 때까지
  posting: 15000, // 제출 뒤 편집 상자가 닫히거나 알림이 뜰 때까지
  verifying: 20000, // 내 댓글이 목록에 나타날 때까지
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 단계 실패를 나타내는 오류 — 어느 단계에서 왜 멈췄는지 담는다. */
class StageError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

// ---- 페이지 안에서 실행되는 함수들 (클로저 없이 인자로만 받는다) ----

/** 로그인한 내 계정의 이름·핸들. 비밀값은 돌려주지 않는다. */
async function pageReadIdentity() {
  const loggedIn = !!window.ytcfg?.get?.('LOGGED_IN');
  if (!loggedIn) return { loggedIn: false };
  const txt = (x) => x?.simpleText ?? (x?.runs ? x.runs.map((r) => r.text).join('') : null);
  let name = null;
  let handle = null;
  let source = null;
  try {
    const r = await fetch('/getAccountSwitcherEndpoint', { credentials: 'same-origin' });
    const j = JSON.parse((await r.text()).replace(/^\)\]\}'\s*/, ''));
    let selected = null;
    const walk = (o) => {
      if (selected || !o || typeof o !== 'object') return;
      if (o.accountName && o.isSelected === true) { selected = o; return; }
      for (const v of Object.values(o)) walk(v);
    };
    walk(j);
    if (selected) {
      name = txt(selected.accountName);
      handle = txt(selected.channelHandle);
      source = 'account-switcher';
    }
  } catch {}
  if (!name && !handle) {
    const n = window.ytcfg?.get?.('USER_ACCOUNT_NAME');
    if (n) { name = String(n); source = 'ytcfg'; }
  }
  return { loggedIn: true, name, handle, source };
}

/** 댓글 영역까지 스크롤하며 입력 상자를 찾는다. 댓글 사용 중지 문구가 보이면 그 문구를 돌려준다. */
function pageFindCommentBox(sel) {
  const c = document.querySelector(sel.comments);
  if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const ph = document.querySelector(sel.placeholder);
  if (ph && ph.getBoundingClientRect().height > 0) return { found: true };
  const msg = document.querySelector(sel.disabledMsg);
  const t = msg?.textContent?.trim();
  if (t && msg.getBoundingClientRect().height > 0) return { found: false, message: t.replace(/\s+/g, ' ') };
  return null;
}

/** 편집칸·초점·제출 버튼 상태. */
function pageEditorState(sel) {
  const ed = document.querySelector(sel.editor);
  const btn = document.querySelector(sel.submit);
  const ph = document.querySelector(sel.placeholder);
  const box = document.querySelector(sel.commentbox);
  return {
    hasEditor: !!ed,
    focused: !!ed && document.activeElement === ed,
    text: ed ? ed.textContent : null,
    submitDisabled: btn ? btn.disabled || btn.getAttribute('aria-disabled') === 'true' : null,
    placeholderVisible: !!ph && ph.getBoundingClientRect().height > 0,
    boxVisible: !!box && box.getBoundingClientRect().height > 0,
  };
}

/** 편집칸을 비운다(편집칸 안만 전체 선택 → 지우기). */
function pageClearEditor(sel) {
  const ed = document.querySelector(sel.editor);
  if (!ed) return false;
  ed.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  return true;
}

/** 댓글 목록에서 (작성자 = 나, 본문 = want) 인 댓글을 센다. */
function pageScanMine(sel, me, want, mode) {
  const n = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const mine = new Set([me.handle, me.name].filter(Boolean).map(n));
  const threads = [...document.querySelectorAll(sel.thread)];
  const rows = threads.map((th, i) => {
    const a = th.querySelector('#author-text');
    const href = a?.getAttribute('href') || '';
    const cands = [
      n(a?.textContent),
      n(th.querySelector('#author-comment-badge')?.textContent), // 영상 주인이 쓴 댓글은 이름이 배지에 들어간다(실측 아님 — 대비용)
      n(dec(href).replace(/^\/+/, '')),
    ].filter(Boolean);
    return { i, author: cands[0] || '', authors: cands, text: n(th.querySelector('#content-text')?.textContent) };
  });
  const isMe = (r) => r.authors.some((x) => mine.has(x));
  const matches = rows.filter((r) => isMe(r) && r.text === n(want));
  const first = matches[0];
  if (first && mode === 'reveal') threads[first.i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  return {
    total: rows.length,
    matchCount: matches.length,
    firstIndex: first ? first.i : -1,
    matchedAuthor: first ? first.author : null,
    matchedText: first ? first.text : null,
    top: rows[0] ? { author: rows[0].author, text: rows[0].text.slice(0, 80) } : null,
  };
}

/** 화면에 떠 있는 알림(토스트) 문구 — 게시 오류 이유를 담기 위해. 선택자는 실측 전이라 확신 낮음. */
function pageToastText() {
  const els = [...document.querySelectorAll('yt-notification-action-renderer, tp-yt-paper-toast')];
  const t = els
    .filter((e) => e.getBoundingClientRect().height > 0)
    .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return t.length ? t.join(' / ') : null;
}

// ---- 본체 ----

/**
 * @param {{ videoId: string, text: string, dryRun?: boolean, delayMs?: number,
 *           onStatus?: (stage: string, detail?: any) => void, profile?: object  // config.profiles 항목, 없으면 profiles[0] }} opts
 * @returns PostResult — { ok, stage, dryRun, verified, commentText, authorName, screenshot, error,
 *                         outcome: 'dry-run'|'posted'|'unknown'|'failed', submitted }
 *   outcome 'unknown' = 제출은 눌렀으나 내 댓글을 화면에서 확인하지 못함(성공·실패를 꾸며내지 않는다).
 */
export async function postComment({ videoId, text, dryRun = true, delayMs, onStatus, profile } = {}) {
  const isDry = dryRun !== false; // false 로 명시했을 때만 게시
  const cfg = loadConfig();
  const useProfile = profile || cfg.profiles?.[0]; // 서버가 고른 프로필, 없으면 config.profiles[0]
  const typingDelay = delayMs ?? cfg.typing?.delayMs ?? 90;

  const result = {
    ok: false,
    stage: 'opening',
    dryRun: isDry,
    verified: false,
    commentText: text ?? null,
    authorName: null,
    screenshot: null,
    error: null,
    outcome: 'failed',
    submitted: false,
  };
  let stage = 'opening';
  const emit = (s, detail) => {
    stage = s;
    result.stage = s;
    try { onStatus?.(s, detail); } catch {}
  };

  let browser = null;
  let page = null;
  let cast = null;
  let keepOpen = false;

  try {
    // 입력값 확인 (창을 열기 전에)
    if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) throw new StageError('opening', `영상 ID 형식이 아닙니다: ${videoId}`);
    if (typeof text !== 'string' || !text.trim()) throw new StageError('opening', '댓글 본문이 비어 있습니다');
    if (/[\r\n\u2028\u2029]/.test(text)) throw new StageError('opening', '본문에 줄바꿈이 있어 입력하지 않았습니다(줄바꿈이 Enter 로 처리될 수 있음)');

    // 1) opening — 보이는 새 창
    emit('opening', { videoId, dryRun: isDry });
    if (!useProfile) throw new StageError('opening', '설정(config.json)에 크롬 프로필이 없습니다');
    browser = await connect({ profile: useProfile });
    page = await browser.newWindow(); // 주소 없이 열고 앞으로 가져온 뒤 영상으로 이동 — 열리는 장면이 먼저 보이게
    cast = await startCast(page).catch(() => null);
    await page.bringToFront();

    // 2) loading — 영상 페이지
    const url = `https://www.youtube.com/watch?v=${videoId}&hl=ko`;
    emit('loading', { step: 'page', url });
    await page.goto(url);
    const info = await page
      .waitFor(
        (id) => {
          const pr = window.ytInitialPlayerResponse;
          // 없는·삭제된 영상: videoDetails 없이 playabilityStatus.status=ERROR 만 온다 → 바로 실패
          if (pr && !pr.videoDetails && pr.playabilityStatus?.status === 'ERROR') {
            return { error: pr.playabilityStatus.reason || '재생할 수 없는 영상' };
          }
          if (!pr?.videoDetails) return null;
          return {
            id: pr.videoDetails.videoId, title: pr.videoDetails.title, isLive: !!pr.videoDetails.isLive,
            lang: document.documentElement.lang, visible: document.visibilityState, hasFocus: document.hasFocus(), wanted: id,
          };
        },
        { timeout: T.player, args: [videoId], what: '영상 정보' },
      )
      .catch((e) => { throw new StageError('loading', `영상 페이지가 열리지 않았습니다 (${e.message})`); });
    if (info.error) throw new StageError('loading', `영상을 열 수 없습니다: ${info.error}`);
    if (info.id !== videoId) throw new StageError('loading', `다른 영상이 열렸습니다 (${info.id})`);
    if (info.isLive) throw new StageError('loading', '지금 라이브 중인 영상이라 댓글 대신 채팅입니다');

    // 내 계정 — 확인 단계에서 작성자를 비교하려면 먼저 알아야 한다
    // 게시 창의 영상 소리가 시연·녹화에 섞이지 않게 멈춘다(자동 재생이 다시 걸릴 수 있어 댓글창 누르기 전에 한 번 더)
    const pausePlayer = () =>
      page.evaluate(() => {
        try { document.getElementById('movie_player')?.pauseVideo?.(); } catch {}
        for (const v of document.querySelectorAll('video')) { try { v.muted = true; v.pause(); } catch {} }
        return true;
      }).catch(() => false);
    await pausePlayer();

    emit('loading', { step: 'account' });
    // 로그인 값(ytcfg LOGGED_IN)이 준비되기 전에 읽으면 '로그인 안 됨'으로 잘못 판정한다 — 값이 생길 때까지 기다린다.
    // 크롬을 막 띄우면 구글 로그인 쿠키가 아직 갱신 전이라 잠깐 '안 됨'으로 보일 수 있다(서버 경유 시 간헐 재현).
    // 그래서 '안 됨'이면 3초 쉬고 새로 고쳐 다시 보기를 최대 30초까지 — 3초·30초는 정한 값.
    const waitLoginFlag = () =>
      page.waitFor(() => (window.ytcfg?.get?.('LOGGED_IN') === undefined ? null : { v: window.ytcfg.get('LOGGED_IN') }), { timeout: 10000, what: '로그인 정보' }).catch(() => null);
    let flag = await waitLoginFlag();
    const loginDeadline = Date.now() + 30000;
    for (let tries = 1; !flag?.v && Date.now() < loginDeadline; tries++) {
      emit('loading', { step: 'account-retry', tries });
      await sleep(3000);
      await page.goto(url);
      await pausePlayer();
      flag = await waitLoginFlag();
    }
    const me = await page.evaluate(pageReadIdentity).catch(() => null);
    if (!me?.loggedIn) throw new StageError('loading', '유튜브에 로그인돼 있지 않습니다');
    if (!me.handle && !me.name) throw new StageError('loading', '로그인한 내 채널 이름을 읽지 못했습니다 — 게시 후 확인이 불가능해 진행하지 않습니다');
    result.authorName = me.handle || me.name;

    // 댓글 영역까지 스크롤 → 입력 상자
    emit('loading', { step: 'comments', title: info.title, lang: info.lang, visible: info.visible, hasFocus: info.hasFocus });
    const box = await page
      .waitFor(pageFindCommentBox, { timeout: T.comments, interval: 500, args: [SEL], what: '댓글 입력 상자' })
      .catch((e) => { throw new StageError('loading', `댓글 입력 상자를 찾지 못했습니다 (${e.message})`); });
    if (!box.found) throw new StageError('loading', `댓글을 달 수 없는 영상입니다: ${box.message}`);

    // 입력 상자 클릭 → 편집칸 초점 확인
    emit('loading', { step: 'focus' });
    await pausePlayer();
    await page.bringToFront();
    await page.click(SEL.placeholder).catch((e) => { throw new StageError('loading', `입력 상자를 누르지 못했습니다 (${e.message})`); });
    let st = await page
      .waitFor((sel) => {
        const ed = document.querySelector(sel.editor);
        return ed && document.activeElement === ed ? { focused: true } : null;
      }, { timeout: T.focus, args: [SEL], what: '편집칸 초점' })
      .catch(() => null);
    if (!st) {
      // 한 번만 편집칸을 직접 눌러 본다
      await page.click(SEL.editor).catch(() => {});
      st = await page.waitFor((sel) => document.activeElement === document.querySelector(sel.editor), { timeout: T.focus, args: [SEL], what: '편집칸 초점' }).catch(() => null);
    }
    if (!st) throw new StageError('loading', '편집칸에 초점이 들어가지 않았습니다');
    const before = await page.evaluate(pageEditorState, SEL);
    if (before.text) throw new StageError('loading', '편집칸이 비어 있지 않습니다(이전 입력이 남아 있음)');

    // 3) typing — 한 글자씩
    const total = Array.from(text).length;
    emit('typing', { typed: 0, total });
    await page.typeText(text, { delayMs: typingDelay, onChar: (typed, n) => emit('typing', { typed, total: n }) });
    const after = await page.evaluate(pageEditorState, SEL);
    if (!after.focused) throw new StageError('typing', '입력 중에 편집칸 초점이 빠졌습니다');
    if (norm(after.text) !== norm(text)) {
      throw new StageError('typing', `입력된 본문이 의도와 다릅니다 (의도 ${total}자 / 입력 ${Array.from(after.text || '').length}자)`);
    }
    result.commentText = norm(after.text);

    if (isDry) {
      // 시험: 게시하지 않는다 — 비우고 취소
      emit('typing', { typed: total, total, step: 'dry-run-clear' });
      await page.evaluate(pageClearEditor, SEL);
      await page
        .waitFor((sel) => {
          const ed = document.querySelector(sel.editor);
          const b = document.querySelector(sel.submit);
          return !!ed && ed.textContent === '' && !!b && (b.disabled || b.getAttribute('aria-disabled') === 'true');
        }, { timeout: T.clear, args: [SEL], what: '편집칸 비우기' })
        .catch((e) => { throw new StageError('typing', `편집칸을 비우지 못했습니다 (${e.message})`); });
      await page.click(SEL.cancel).catch((e) => { throw new StageError('typing', `취소 버튼을 누르지 못했습니다 (${e.message})`); });
      await page
        .waitFor((sel) => {
          const ph = document.querySelector(sel.placeholder);
          const box = document.querySelector(sel.commentbox);
          return !!ph && ph.getBoundingClientRect().height > 0 && !(box && box.getBoundingClientRect().height > 0);
        }, { timeout: T.close, args: [SEL], what: '편집 상자 닫힘' })
        .catch((e) => { throw new StageError('typing', `취소 뒤 편집 상자가 닫히지 않았습니다 (${e.message})`); });
      result.ok = true;
      result.verified = false;
      result.outcome = 'dry-run';
      emit('done', { outcome: 'dry-run', typed: total });
      return result;
    }

    // ---- 여기부터 실제 게시 (dryRun === false 일 때만) ----
    // 4) posting
    emit('posting', { step: 'wait-submit' });
    const pre = await page.evaluate(pageScanMine, SEL, me, text);
    await page
      .waitFor((sel) => {
        const b = document.querySelector(sel.submit);
        return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      }, { timeout: T.submitEnabled, args: [SEL], what: '제출 버튼 활성화' })
      .catch((e) => { throw new StageError('posting', `제출 버튼이 켜지지 않았습니다 (${e.message})`); });
    emit('posting', { step: 'submit' });
    await page.click(SEL.submit).catch((e) => { throw new StageError('posting', `제출 버튼을 누르지 못했습니다 (${e.message})`); });
    result.submitted = true;
    keepOpen = true; // 제출했으면 창을 남겨 사람이 직접 볼 수 있게
    const closed = await page
      .waitFor((sel) => {
        const ph = document.querySelector(sel.placeholder);
        const box = document.querySelector(sel.commentbox);
        if (!(box && box.getBoundingClientRect().height > 0) && ph && ph.getBoundingClientRect().height > 0) return { closed: true };
        return null;
      }, { timeout: T.posting, args: [SEL], what: '편집 상자 닫힘' })
      .catch(() => null);
    const toast = await page.evaluate(pageToastText).catch(() => null);

    // 5) verifying — 내 댓글이 목록에 새로 생겼는지
    emit('verifying', { boxClosed: !!closed, toast });
    const end = Date.now() + T.verifying;
    let scan = null;
    while (Date.now() < end) {
      scan = await page.evaluate(pageScanMine, SEL, me, text, 'reveal').catch(() => null);
      if (scan && scan.matchCount > pre.matchCount) break;
      await sleep(500);
    }
    if (scan && scan.matchCount > pre.matchCount) {
      result.ok = true;
      result.verified = true;
      result.outcome = 'posted';
      result.authorName = scan.matchedAuthor || result.authorName;
      result.commentText = scan.matchedText;
      await sleep(400); // 내 댓글을 화면 가운데로 옮긴 뒤 찍는다(사용자 결정: 성공 때도 증거 캡처)
      result.screenshot = await capture(page, videoId);
      emit('done', { outcome: 'posted', position: scan.firstIndex, total: scan.total, screenshot: result.screenshot });
      return result;
    }
    // 못 찾음 = 결과 불명. 성공·실패를 꾸며내지 않는다.
    result.ok = false;
    result.verified = false;
    result.outcome = 'unknown';
    result.error = `결과 불명: 제출은 눌렀으나 ${T.verifying / 1000}초 안에 내 댓글(작성자 ${result.authorName})을 목록에서 찾지 못했습니다` +
      (closed ? '' : ' · 편집 상자가 닫히지 않음') + (toast ? ` · 화면 알림: ${toast}` : '') +
      (scan?.top ? ` · 맨 위 댓글 작성자: ${scan.top.author}` : '');
    result.screenshot = await capture(page, videoId);
    // 'done' 으로 보내면 화면이 "게시 완료"로 읽을 수 있어 'failed' + outcome:'unknown' 으로 보낸다(계약에 '결과 불명' 단계가 없음).
    result.stage = 'verifying';
    try { onStatus?.('failed', { stage: 'verifying', outcome: 'unknown', error: result.error, screenshot: result.screenshot }); } catch {}
    return result;
  } catch (e) {
    const failStage = e instanceof StageError ? e.stage : stage;
    result.ok = false;
    result.stage = failStage;
    result.outcome = result.submitted ? 'unknown' : 'failed';
    result.error = (result.submitted ? '결과 불명: ' : '') + (e?.message || String(e));
    if (page) result.screenshot = await capture(page, videoId);
    stage = 'failed';
    try { onStatus?.('failed', { stage: failStage, error: result.error, screenshot: result.screenshot, outcome: result.outcome }); } catch {}
    return result;
  } finally {
    if (cast) await cast.stop().catch(() => {});
    if (browser) {
      try {
        await browser.disconnect(keepOpen && page ? { keepOpen: [page.targetId] } : {});
      } catch {}
    }
  }
}

// 시연 녹화용 — JG_RECORD_POST_DIR 이 있을 때만. 게시 탭 화면을 크롬 화면 전송(Page.startScreencast)으로 받아
// 프레임(jpg)과 받은 시각을 저장한다. 창이 모니터 밖에 있어도 된다(사용자 화면을 덮지 않고 녹화 — 2026-10-20 사용자 결정).
async function startCast(page) {
  const dir = process.env.JG_RECORD_POST_DIR;
  if (!dir || typeof page.onCdp !== 'function') return null;
  const out = join(dir, `post-${stamp()}`);
  await mkdir(out, { recursive: true });
  const frames = [];
  let n = 0;
  await page.onCdp('Page.screencastFrame', (f) => {
    const file = `f${String(++n).padStart(5, '0')}.jpg`;
    frames.push({ file, t: Date.now() });
    writeFile(join(out, file), Buffer.from(f.data, 'base64')).catch(() => {});
    page.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const [w, h] = (process.env.JG_OFFSCREEN_SIZE || '1600,900').split(',').map(Number);
  await page.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
  return {
    async stop() {
      try { await page.send('Page.stopScreencast'); } catch {}
      await writeFile(join(out, 'frames.json'), JSON.stringify({ frames, endedAt: Date.now() }));
    },
  };
}

async function capture(page, videoId) {
  try {
    const dir = join(DATA_DIR, 'captures');
    await mkdir(dir, { recursive: true });
    const safeId = String(videoId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
    return await page.screenshot(join(dir, `${stamp()}_${safeId}.png`));
  } catch {
    return null;
  }
}

/** 시험용 — 실제 게시 없이 화면 구조·확인 로직을 읽기 전용으로 점검할 때만 쓴다. */
export const __test = { SEL, T, pageScanMine, pageFindCommentBox, pageEditorState, pageReadIdentity };
