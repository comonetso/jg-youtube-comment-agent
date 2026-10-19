// 대시보드 화면 동작 — 서버 API(/api/*)와 실시간 알림(/api/events)만 쓴다.
// 규칙(허용 채널·영상당 1개·하루 상한)은 서버가 강제한다. 화면은 미리 알려 주고 버튼을 막아 줄 뿐이다.
const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  videos: [],
  testVideos: [],
  selected: null, // { videoId, meta, draft, lock, source, check, edited }
  draftToken: 0,
  draftRequestId: null,
  draftLoading: false,
  posting: false,
  today: { count: 0, max: 10 },
  log: [],
};

const MODULE_NAMES = { collect: '영상 내용 읽기(collect)', ai: 'AI 초안(ai)', post: '댓글 게시(post)' };
const SOURCE_NAMES = { transcript: '자막', description: '설명', title: '제목', comment: '인기 댓글' };
const STEPS = [
  { key: 'opening', label: '프로필 여는 중' },
  { key: 'loading', label: '영상·댓글 창 여는 중' },
  { key: 'typing', label: '한 글자씩 입력 중' },
  { key: 'posting', label: '게시 중' },
  { key: 'verifying', label: '내 댓글 확인 중' },
];

// ── 도우미 ──────────────────────────────────────────────────────────
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { status: 0, data: { ok: false, error: '대시보드 서버에 연결하지 못했습니다. 서버(node src/server.mjs)가 켜져 있는지 확인하세요.' } };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `서버 응답을 읽지 못했습니다 (HTTP ${res.status})` };
  }
  return { status: res.status, data };
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}
function ago(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  const now = new Date();
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const n = Math.round((b - a) / 86400000);
  if (n <= 0) return '오늘';
  if (n === 1) return '어제';
  return `${n}일 전`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtSec(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
// 글자 수 — src/validate.mjs 와 같은 셈법(사람이 보는 글자 하나 = 1, 최대는 공백 포함 · 최소는 공백 빼고)
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
function charLen(s) {
  const t = String(s || '').normalize('NFC');
  if (!segmenter) return Array.from(t).length;
  let n = 0;
  for (const _ of segmenter.segment(t)) n++;
  return n;
}
const lengths = (text) => ({ withSpaces: charLen(text), withoutSpaces: charLen(text.replace(/\s+/gu, '')) });

// 게시 부품(post.mjs)이 detail.step 으로 알리는 세부 단계
const SUBSTEP = {
  page: '영상 페이지 여는 중',
  account: '내 계정 확인 중',
  comments: '댓글 입력칸 찾는 중',
  focus: '입력칸 누르는 중',
  'wait-submit': '제출 버튼 기다리는 중',
  submit: '제출 버튼 누름',
  'dry-run-clear': '연습이라 입력한 글을 지우는 중',
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function setStatus(id, text, kind = '') {
  const box = $(id);
  box.textContent = text || '';
  box.className = `status ${kind}`.trim();
}
function showMsg(id, text, kind) {
  const box = $(id);
  if (!text) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.className = `msg ${kind}`;
  box.replaceChildren(...(Array.isArray(text) ? text : [text]));
}

function setToday(t) {
  if (!t) return;
  state.today = t;
  for (const id of ['todayCount', 'todayCount2']) $(id).textContent = t.count;
  for (const id of ['todayMax', 'todayMax2']) $(id).textContent = t.max;
  $('limitText').textContent = t.max;
  updatePostButtons();
}

// ── 설정 ────────────────────────────────────────────────────────────
async function loadConfig() {
  const { data } = await api('/api/config');
  if (!data.ok) {
    showMsg('moduleNotice', data.error, 'error');
    $('moduleNotice').hidden = false;
    return;
  }
  state.config = data;
  const sel = $('profileSelect');
  sel.replaceChildren(...data.profiles.map((p) => el('option', { value: p.id, text: p.name })));
  if (!data.profiles.length) sel.append(el('option', { value: '', text: '(설정에 프로필이 없습니다)' }));
  sel.disabled = data.profiles.length <= 1;
  setToday(data.today);

  const missing = Object.keys(MODULE_NAMES).filter((k) => !data.modules[k]);
  if (missing.length) {
    const box = $('moduleNotice');
    box.hidden = false;
    box.textContent = `아직 준비되지 않은 부품이 있습니다: ${missing.map((k) => MODULE_NAMES[k]).join(' · ')}. 그 기능을 누르면 이유가 표시됩니다.`;
  }
  updateCharCount();
}

// ── ① 영상 불러오기 ─────────────────────────────────────────────────
async function loadVideos() {
  const btn = $('btnLoad');
  btn.disabled = true;
  btn.textContent = '불러오는 중…';
  setStatus('loadStatus', '지정 채널 5곳의 최신 영상을 가져오는 중입니다…', 'loading');
  const { data } = await api('/api/videos');
  btn.disabled = false;
  btn.textContent = '다시 불러오기';
  if (!data.ok) {
    setStatus('loadStatus', data.error, 'error');
    return;
  }
  state.videos = data.videos || [];
  state.testVideos = data.testVideos || [];
  setToday(data.today);
  let msg = `영상 ${state.videos.length}개를 불러왔습니다. 하나를 누르면 ② 에 초안이 만들어집니다.`;
  if (data.errors?.length) msg += ` (불러오지 못한 채널: ${data.errors.map((e) => e.channel).join(', ')})`;
  setStatus('loadStatus', msg, data.errors?.length ? 'warn' : 'ok');

  const filter = $('channelFilter');
  const keep = filter.value;
  filter.replaceChildren(
    el('option', { value: '', text: '모든 채널' }),
    ...(state.config?.channels || []).map((c) => el('option', { value: c.id, text: c.name })),
  );
  filter.value = keep;
  filter.hidden = false;
  renderVideos();
}

function renderVideos() {
  const list = $('videoList');
  list.replaceChildren();
  const filter = $('channelFilter').value;
  if (state.testVideos.length) {
    list.append(el('div', { class: 'group-title', text: '내 테스트 영상' }));
    for (const v of state.testVideos) list.append(videoCard(v, true));
    list.append(el('div', { class: 'group-title', text: '채널 최신 영상' }));
  }
  const vids = state.videos.filter((v) => !filter || v.channelId === filter);
  for (const v of vids) list.append(videoCard(v, false));
  if (!vids.length) list.append(el('p', { class: 'empty', text: '영상이 없습니다.' }));
}

function videoCard(v, isTest) {
  const selected = state.selected?.videoId === v.videoId;
  const badges = [];
  if (isTest) badges.push(el('span', { class: 'badge test', text: '내 테스트 영상' }));
  if (v.lock) badges.push(el('span', { class: `badge ${v.lock.result}`, text: v.lock.result === 'pending' ? '진행 중' : '댓글 달림' }));
  const when = v.publishedAt ? `${fmtDate(v.publishedAt)} · ${ago(v.publishedAt)}` : '';
  return el(
    'button',
    { type: 'button', class: `video-card${selected ? ' selected' : ''}`, 'data-id': v.videoId, onclick: () => selectVideo(v) },
    el('img', { class: 'thumb', src: v.thumbnail, alt: '', loading: 'lazy' }),
    el(
      'span',
      { class: 'vc-body' },
      el('span', { class: 'vc-title', text: v.title || v.note || `영상 ${v.videoId}` }),
      el('span', { class: 'vc-meta', text: v.channelName || '' }),
      when ? el('span', { class: 'vc-meta', text: `올린 날짜 ${when}` }) : null,
      badges.length ? el('span', { class: 'vc-badges' }, badges) : null,
    ),
  );
}

function markSelectedCard() {
  for (const card of document.querySelectorAll('.video-card')) {
    card.classList.toggle('selected', card.dataset.id === state.selected?.videoId);
  }
}

// ── ② 영상 고르기 · 초안 ────────────────────────────────────────────
function busyGuard() {
  if (!state.posting) return false;
  setStatus('loadStatus', '댓글을 다는 중입니다. 끝난 뒤에 다른 영상을 고를 수 있습니다.', 'warn');
  return true;
}

function selectVideo(v) {
  if (busyGuard()) return;
  showMsg('linkError', null);
  state.selected = { videoId: v.videoId, meta: v, draft: null, lock: v.lock || null };
  markSelectedCard();
  renderSelected();
  requestDraft({ videoId: v.videoId });
}

function selectByLink(url) {
  if (busyGuard()) return;
  showMsg('linkError', null);
  if (!url) {
    showMsg('linkError', '유튜브 링크를 붙여넣어 주세요.', 'error');
    return;
  }
  state.selected = { videoId: null, meta: { title: '링크 확인 중…' }, draft: null, lock: null };
  markSelectedCard();
  renderSelected();
  requestDraft({ url }, { fromLink: true });
}

async function requestDraft(payload, { fromLink = false, regenerate = false } = {}) {
  const token = ++state.draftToken;
  const requestId = newId();
  state.draftRequestId = requestId;
  state.draftLoading = true;
  showMsg('draftError', null);
  setStatus('draftStatus', fromLink ? '링크의 영상과 채널을 확인하는 중…' : '영상 정보·채널 확인 중…', 'loading');
  if (!regenerate) $('draftBox').hidden = true;
  $('btnRegen').disabled = true;
  updatePostButtons();

  const { data } = await api('/api/draft', { method: 'POST', body: { ...payload, requestId, regenerate } });
  if (token !== state.draftToken) return; // 그사이 다른 영상을 골랐다
  state.draftLoading = false;
  $('btnRegen').disabled = false;

  if (!data.ok) {
    setStatus('draftStatus', '');
    const linkProblem = fromLink && (data.code === 'BAD_INPUT' || data.code === 'NOT_ALLOWED');
    if (linkProblem) {
      showMsg('linkError', data.code === 'NOT_ALLOWED' ? ['이 링크에는 댓글을 달 수 없습니다. ', data.error] : data.error, 'error');
      state.selected = null;
      renderSelected();
    } else {
      if (data.meta && state.selected) {
        state.selected.videoId = data.meta.videoId;
        state.selected.meta = data.meta;
        renderSelected();
      }
      showMsg('draftError', data.error, 'error');
    }
    updatePostButtons();
    return;
  }

  if (fromLink) $('linkInput').value = '';
  state.selected = {
    videoId: data.videoId,
    meta: data.meta,
    draft: data.draft,
    lock: data.lock,
    source: data.source,
    check: data.check,
    draftError: data.draftError || null,
    edited: false,
  };
  setToday(data.today);
  setStatus('draftStatus', '초안이 준비됐습니다. 마음에 들면 ③ 으로, 아니면 고치거나 [다시 만들기].', 'ok');
  markSelectedCard();
  renderSelected();
  renderDraft();
}

function renderSelected() {
  const s = state.selected;
  $('selectedEmpty').hidden = !!s;
  $('selectedBox').hidden = !s;
  const box = $('selectedCard');
  box.replaceChildren();
  if (!s) {
    $('draftBox').hidden = true;
    updatePostButtons();
    return;
  }
  const m = s.meta || {};
  const when = m.publishedAt ? `올린 날짜 ${fmtDate(m.publishedAt)} · ${ago(m.publishedAt)}` : '';
  box.append(
    s.videoId ? el('img', { class: 'thumb big', src: m.thumbnail || `https://i.ytimg.com/vi/${s.videoId}/hqdefault.jpg`, alt: '' }) : null,
    el(
      'div',
      { class: 'sc-body' },
      s.videoId
        ? el('a', { class: 'sc-title', href: m.url || `https://www.youtube.com/watch?v=${s.videoId}`, target: '_blank', rel: 'noopener', text: m.title || `영상 ${s.videoId}` })
        : el('div', { class: 'sc-title', text: m.title || '' }),
      el('div', { class: 'vc-meta', text: [m.channelName, when].filter(Boolean).join(' · ') }),
      s.lock ? el('span', { class: `badge ${s.lock.result}`, text: `이미 댓글 달림 (${s.lock.label})` }) : null,
    ),
  );
  updatePostButtons();
}

function renderDraft() {
  const s = state.selected;
  const d = s?.draft;
  if (!d) {
    $('draftBox').hidden = true;
    return;
  }
  $('draftBox').hidden = false;
  $('worry').textContent = d.worry || '(AI 가 고민을 정리하지 못했습니다)';
  $('commentText').value = d.comment || '';

  const list = $('evidenceList');
  list.replaceChildren();
  const ev = Array.isArray(d.evidence) ? d.evidence : [];
  for (const e of ev) {
    const hasT = typeof e.t === 'number' && Number.isFinite(e.t);
    list.append(
      el(
        'li',
        {},
        el('span', { class: 'ev-src', text: SOURCE_NAMES[e.source] || e.source || '근거' }),
        hasT
          ? el('a', { class: 'ev-time', href: `https://www.youtube.com/watch?v=${s.videoId}&t=${Math.floor(e.t)}s`, target: '_blank', rel: 'noopener', title: '그 장면부터 보기', text: fmtSec(e.t) })
          : null,
        el('q', { text: e.quote || '' }),
      ),
    );
  }
  if (!ev.length) list.append(el('li', { class: 'muted', text: '근거 인용이 없습니다.' }));

  const src = s.source || {};
  const parts = [];
  if (src.transcript === 'ok') parts.push(`자막${src.transcriptLang ? `(${src.transcriptLang})` : ''}을 읽고 만들었습니다`);
  else if (src.transcript === 'none') parts.push('이 영상엔 자막이 없어 제목·설명으로 만들었습니다');
  else if (src.transcript === 'failed') parts.push('자막을 가져오지 못해 제목·설명으로 만들었습니다');
  if (src.topComments) parts.push(`인기 댓글 ${src.topComments}개 참고`);
  if (d.provider) parts.push(`작성: ${d.provider}`);
  $('sourceNote').textContent = parts.join(' · ');

  updateCharCount();
}

/** 화면에서 미리 막는 것 — 서버도 같은 검사를 한다(서버가 최종) */
function blockingIssues(text) {
  const c = state.config?.comment || {};
  const t = text.trim();
  const { withSpaces, withoutSpaces } = lengths(t);
  const issues = [];
  if (!t) issues.push('댓글이 비어 있습니다.');
  else {
    if (c.minChars && withoutSpaces < c.minChars) issues.push(`공백 빼고 ${c.minChars}자 이상이어야 합니다.`);
    if (c.maxChars && withSpaces > c.maxChars) issues.push(`공백 포함 ${c.maxChars}자 이하여야 합니다.`);
  }
  if (/(https?:\/\/|www\.)/i.test(t)) issues.push('링크는 넣을 수 없습니다.');
  if (/[#＃]\S/u.test(t)) issues.push('해시태그는 넣을 수 없습니다.');
  return issues;
}

function updateCharCount() {
  const text = $('commentText').value.trim();
  const c = state.config?.comment || {};
  const { withSpaces, withoutSpaces } = lengths(text);
  const tooLong = c.maxChars && withSpaces > c.maxChars;
  const tooShort = c.minChars && withoutSpaces < c.minChars;
  const cc = $('charCount');
  cc.textContent = c.minChars && c.maxChars
    ? `공백 포함 ${withSpaces}자(최대 ${c.maxChars}) · 공백 빼고 ${withoutSpaces}자(최소 ${c.minChars})`
    : `${withSpaces}자`;
  cc.className = `char-count ${tooLong || tooShort ? 'bad' : 'good'}`;

  const s = state.selected;
  const warn = [];
  const issues = text ? blockingIssues(text) : [];
  if (issues.length) warn.push(issues.join(' '));
  if (!s?.edited) {
    // 고치기 전 AI 초안 그대로일 때만 — 고친 글은 [댓글 달기] 때 서버가 다시 검사한다
    if (s?.draftError) warn.push(`AI 초안이 규칙 검사를 다 통과하지 못했습니다: ${s.draftError} 직접 고치거나 [다시 만들기]를 눌러 주세요.`);
    else if (s?.check && s.check.ok === false && s.check.errors?.length) warn.push(`초안이 규칙에 맞지 않습니다: ${s.check.errors.join(' ')}`);
  }
  if (c.brand && text && !text.includes(c.brand)) warn.push(`‘${c.brand}’ 이름이 빠져 있습니다(달 때 서버 검사에서 막힙니다).`);
  showMsg('textWarn', warn.length ? warn.join(' ') : null, 'warn');
  updatePostButtons();
}

// ── ③ 댓글 달기 ─────────────────────────────────────────────────────
function currentProfile() {
  const id = $('profileSelect').value;
  return state.config?.profiles?.find((p) => p.id === id) || null;
}

function updatePostButtons() {
  const s = state.selected;
  const text = $('commentText').value;
  let msg;
  let kind = 'info';
  let canPost = false;
  let canPractice = false;
  if (state.posting) {
    msg = '진행 중입니다. 끝날 때까지 기다려 주세요.';
  } else if (!s?.videoId && !state.draftLoading) {
    msg = '② 에서 영상을 먼저 고르세요.';
  } else if (state.draftLoading || !s?.draft) {
    msg = state.draftLoading ? '댓글 초안을 만드는 중입니다…' : '댓글 초안이 있어야 달 수 있습니다.';
  } else if (!currentProfile()) {
    msg = '프로필이 없습니다. config.json 의 profiles 를 확인하세요.';
    kind = 'warn';
  } else {
    const issues = blockingIssues(text);
    if (issues.length) {
      msg = `댓글을 고쳐 주세요: ${issues.join(' ')}`;
      kind = 'warn';
    } else if (s.lock) {
      canPractice = true;
      kind = 'warn';
      msg = `이 영상에는 이미 댓글을 달았습니다(${s.lock.label} · ${fmtTime(s.lock.time)} · ${s.lock.profileName || s.lock.profileId}). 영상당 1개만 달 수 있어 [댓글 달기]를 막았습니다. 연습은 할 수 있습니다.`;
    } else if (state.today.count >= state.today.max) {
      canPractice = true;
      kind = 'warn';
      msg = `오늘 게시 상한(${state.today.max}개)에 도달했습니다. 연습만 할 수 있습니다.`;
    } else {
      canPost = canPractice = true;
      kind = 'ok';
      msg = `준비됐습니다. [댓글 달기]를 누르면 ‘${currentProfile().name}’ 프로필 창이 열립니다.`;
    }
  }
  $('btnPost').disabled = !canPost;
  $('btnPractice').disabled = !canPractice;
  $('commentText').readOnly = state.posting;
  $('btnRegen').disabled = state.posting || state.draftLoading || !s?.videoId;
  showMsg('postBlock', msg, kind);
}

function resetProgress(dryRun) {
  $('progressBox').hidden = false;
  $('progressTitle').textContent = dryRun ? '진행 상태 — 연습 (게시 안 함)' : '진행 상태';
  $('progress').replaceChildren(
    ...STEPS.map((s) =>
      el(
        'li',
        { class: 'step', 'data-key': s.key },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'step-label', text: dryRun && (s.key === 'posting' || s.key === 'verifying') ? `${s.label} — 연습이라 하지 않음` : s.label }),
        el('span', { class: 'step-detail' }),
        s.key === 'typing' ? el('span', { class: 'bar', hidden: true }, el('span', { class: 'bar-fill' })) : null,
      ),
    ),
  );
}

function stepEl(key) {
  return $('progress').querySelector(`li[data-key="${key}"]`);
}

function setActiveStep(key) {
  const idx = STEPS.findIndex((s) => s.key === key);
  if (idx < 0) return;
  STEPS.forEach((s, i) => {
    const li = stepEl(s.key);
    if (!li) return;
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
}

/** 끝났을 때 — 단계를 모두 완료로, 세부 문구는 지우고 입력 칸에는 n / n 만 남긴다 */
function finishSteps(dryRun) {
  for (const s of STEPS) {
    const li = stepEl(s.key);
    if (!li) continue;
    li.classList.remove('active');
    li.classList.add(dryRun && (s.key === 'posting' || s.key === 'verifying') ? 'skipped' : 'done');
    const detail = li.querySelector('.step-detail');
    detail.textContent = s.key === 'typing' && state.lastTyping ? `${state.lastTyping.total} / ${state.lastTyping.total}` : '';
  }
}

function onPostEvent(ev) {
  if (!ev) return;
  if (ev.stage === 'start') {
    state.lastTyping = null;
    resetProgress(ev.dryRun);
    showMsg('postResult', null);
    return;
  }
  if (!$('progress').children.length) resetProgress(ev.dryRun);
  if (ev.final) {
    showFinal(ev.entry, ev.ok);
    return;
  }
  if (ev.stage === 'typing') {
    setActiveStep('typing');
    const li = stepEl('typing');
    const typed = Number(ev.detail?.typed);
    const total = Number(ev.detail?.total);
    if (li && Number.isFinite(typed) && Number.isFinite(total) && total > 0) {
      state.lastTyping = { typed, total };
      li.querySelector('.step-detail').textContent = ev.detail?.step ? SUBSTEP[ev.detail.step] || `${typed} / ${total}` : `${typed} / ${total}`;
      const bar = li.querySelector('.bar');
      bar.hidden = false;
      bar.firstChild.style.width = `${Math.min(100, Math.round((typed / total) * 100))}%`;
    }
    return;
  }
  if (ev.stage === 'done') {
    finishSteps(ev.dryRun);
    return;
  }
  if (ev.stage === 'failed') {
    // post.mjs: detail = { stage, error, screenshot, outcome } — outcome 'unknown' 이면 결과불명
    const d = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
    const target = stepEl(d.stage) || $('progress').querySelector('li.active') || stepEl(STEPS[0].key);
    if (target) {
      target.classList.remove('active');
      target.classList.add(d.outcome === 'unknown' ? 'unknown' : 'failed');
      target.querySelector('.step-detail').textContent = d.outcome === 'unknown' ? '결과불명' : '멈춤';
    }
    return;
  }
  setActiveStep(ev.stage);
  const li = stepEl(ev.stage);
  if (!li) return;
  const d = ev.detail;
  const text = typeof d === 'string' ? d : d && typeof d === 'object' ? SUBSTEP[d.step] || '' : '';
  if (text) li.querySelector('.step-detail').textContent = text;
}

function showFinal(entry, ok) {
  if (!entry) return;
  // 진행 표시 마무리
  if (entry.result === 'success' || (entry.result === 'practice' && ok)) {
    finishSteps(entry.dryRun);
  } else {
    const active = stepEl(entry.stage) || $('progress').querySelector('li.active') || stepEl(STEPS[0].key);
    if (active && !active.classList.contains('failed')) {
      active.classList.remove('active');
      active.classList.add(entry.result === 'unknown' ? 'unknown' : 'failed');
    }
  }

  const links = [];
  const capture = entry.screenshotUrl ? el('a', { href: entry.screenshotUrl, target: '_blank', text: '캡처 보기' }) : null;
  let kind;
  let head;
  if (entry.result === 'success') {
    kind = 'ok';
    head = '게시 완료 — 내 댓글이 보이는 것을 확인했습니다.';
    links.push(el('a', { href: entry.commentUrl || entry.url, target: '_blank', rel: 'noopener', text: '댓글 보기' }));
  } else if (entry.result === 'practice') {
    kind = ok ? 'info' : 'error';
    head = ok ? '연습 완료 — 입력까지만 하고 게시 버튼은 누르지 않았습니다.' : `연습 중 멈췄습니다. ${entry.reason}`;
    if (capture) links.push(capture);
  } else if (entry.result === 'unknown') {
    kind = 'warn';
    head = `결과불명 — ${entry.reason}`;
    if (capture) links.push(capture);
    links.push(el('a', { href: entry.url, target: '_blank', rel: 'noopener', text: '영상에서 직접 확인' }));
  } else {
    kind = 'error';
    head = `실패 — ${entry.reason} 게시되지 않았으니 다시 시도할 수 있습니다.`;
    if (capture) links.push(capture);
  }
  const linkNodes = [];
  links.forEach((a, i) => {
    if (i) linkNodes.push(' · ');
    linkNodes.push(a);
  });
  showMsg('postResult', [el('div', { text: head }), linkNodes.length ? el('div', { class: 'links' }, linkNodes) : null].filter(Boolean), kind);

  // 이 영상 잠금 반영
  if (!entry.dryRun && ['success', 'unknown', 'pending'].includes(entry.result)) {
    const lock = { result: entry.result, label: entry.resultLabel, time: entry.time, profileId: entry.profileId, profileName: entry.profileName };
    for (const v of [...state.videos, ...state.testVideos]) if (v.videoId === entry.videoId) v.lock = lock;
    if (state.selected?.videoId === entry.videoId) state.selected.lock = lock;
    renderVideos();
    renderSelected();
  }
}

async function doPost(dryRun) {
  const s = state.selected;
  if (!s?.videoId || state.posting) return;
  const text = $('commentText').value.trim();
  state.posting = true;
  resetProgress(dryRun);
  showMsg('postResult', null);
  updatePostButtons();

  const { data } = await api('/api/post', {
    method: 'POST',
    body: { videoId: s.videoId, text, profileId: $('profileSelect').value, dryRun },
  });
  state.posting = false;

  if (data.entry) {
    showFinal(data.entry, data.ok);
  } else {
    // 규칙에 막혔거나 시작 전에 멈춤 — 기록에 남지 않는다
    $('progressBox').hidden = true;
    const head = data.code === 'NOT_ALLOWED' || data.code === 'ALREADY_COMMENTED' || data.code === 'DAILY_LIMIT' ? '규칙에 막혀 달지 않았습니다. ' : '시작하지 못했습니다. ';
    showMsg('postResult', `${head}${data.error || ''}`, 'error');
    if (data.code === 'ALREADY_COMMENTED') {
      await loadLog();
      const e = [...state.log].reverse().find((x) => x.videoId === s.videoId && !x.dryRun && ['success', 'unknown', 'pending'].includes(x.result));
      if (e) state.selected.lock = { result: e.result, label: e.resultLabel, time: e.time, profileId: e.profileId, profileName: e.profileName };
    }
  }
  if (data.today) setToday(data.today);
  updatePostButtons();
  loadLog();
}

// ── 기록 ────────────────────────────────────────────────────────────
async function loadLog() {
  const { data } = await api('/api/log');
  if (!data.ok) return;
  state.log = data.entries || [];
  setToday(data.today);
  renderLog();
}

function renderLog() {
  const tbody = $('logTable').querySelector('tbody');
  tbody.replaceChildren();
  const rows = [...state.log].reverse(); // 최근 것이 위
  $('logEmpty').hidden = rows.length > 0;
  $('logTable').hidden = rows.length === 0;
  for (const e of rows) {
    const extra = [];
    if (e.screenshotUrl) extra.push(el('a', { href: e.screenshotUrl, target: '_blank', text: '캡처 보기' }));
    if (e.result === 'success') extra.push(el('a', { href: e.commentUrl || e.url, target: '_blank', rel: 'noopener', text: '댓글 보기' }));
    tbody.append(
      el(
        'tr',
        {},
        el('td', { class: 'nowrap', text: fmtTime(e.time) }),
        el('td', { class: 'nowrap' }, el('span', { class: `badge ${e.result}`, text: e.resultLabel || e.result })),
        el('td', { class: 'title-cell' }, el('a', { href: e.url, target: '_blank', rel: 'noopener', text: e.title || e.videoId })),
        el('td', { class: 'nowrap', text: e.channelName || (e.allowedBy === 'testVideo' ? '테스트 영상' : '') }),
        el('td', { class: 'nowrap', text: e.profileName || e.profileId || '' }),
        el('td', { class: 'comment-cell', text: e.comment || '' }),
        el('td', { class: 'reason-cell' }, e.reason || '', extra.length ? el('div', { class: 'links' }, extra.flatMap((a, i) => (i ? [' · ', a] : [a]))) : null),
      ),
    );
  }
}

// ── 실시간 알림 ─────────────────────────────────────────────────────
function connectEvents() {
  const es = new EventSource('/api/events');
  const parse = (m) => {
    try {
      return JSON.parse(m.data);
    } catch {
      return null;
    }
  };
  es.addEventListener('hello', (m) => {
    const d = parse(m);
    if (!d) return;
    setToday(d.today);
    if (d.job && !state.posting) {
      // 게시 도중 화면을 새로 열었을 때 — 지금 단계만 보여 준다
      resetProgress(d.job.dryRun);
      onPostEvent(d.job);
    }
  });
  es.addEventListener('draft', (m) => {
    const d = parse(m);
    if (!d || d.requestId !== state.draftRequestId) return;
    if (d.stage === 'done' || d.stage === 'failed') return;
    if (d.label) setStatus('draftStatus', `${d.label}…`, 'loading');
  });
  es.addEventListener('post', (m) => onPostEvent(parse(m)));
  es.addEventListener('log', (m) => {
    const d = parse(m);
    if (d?.today) setToday(d.today);
    loadLog();
  });
}

// ── 연결 ────────────────────────────────────────────────────────────
$('btnLoad').addEventListener('click', loadVideos);
$('channelFilter').addEventListener('change', renderVideos);
$('linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  selectByLink($('linkInput').value.trim());
});
$('commentText').addEventListener('input', (e) => {
  // 유튜브 댓글은 한 줄로 단다 — 줄바꿈은 띄어쓰기로 바꾼다(게시 부품도 줄바꿈 든 글은 입력하지 않는다)
  const ta = e.target;
  if (/[\r\n]/.test(ta.value)) {
    const pos = ta.selectionStart;
    ta.value = ta.value.replace(/\r\n|[\r\n]/g, ' ');
    ta.setSelectionRange(pos, pos);
  }
  if (state.selected) state.selected.edited = true;
  updateCharCount();
});
$('btnRegen').addEventListener('click', () => {
  const s = state.selected;
  if (!s?.videoId || state.posting) return;
  if (s.edited && !confirm('다시 만들면 고친 댓글이 새 초안으로 바뀝니다. 계속할까요?')) return;
  requestDraft({ videoId: s.videoId }, { regenerate: true });
});
$('profileSelect').addEventListener('change', updatePostButtons);
$('btnPost').addEventListener('click', () => doPost(false));
$('btnPractice').addEventListener('click', () => doPost(true));

connectEvents();
loadConfig().then(loadLog);
