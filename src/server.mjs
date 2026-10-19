// 대시보드 서버 — node:http 만 쓴다. 127.0.0.1 에만 연다.
//   node src/server.mjs  →  http://127.0.0.1:4310
//
// API (docs/contracts.md "화면·규칙")
//   GET  /api/videos   지정 채널 최신 영상 + 내 테스트 영상
//   POST /api/draft    { videoId | url, regenerate? }  → 고민 한 줄 · 댓글 초안
//   POST /api/post     { videoId, text, profileId, dryRun }  → 게시(또는 연습) 결과
//   GET  /api/events   SSE — 초안·게시 진행 단계 실시간
//   GET  /api/log      시간순 기록
//   GET  /api/config   화면에 필요한 설정(비밀값 없음)
//
// 다른 담당 부품(collect · ai · validate · post)은 요청 때 동적으로 불러온다.
// 없으면 무엇이 빠졌는지 알려 주는 오류를 돌려준다.
//
// 시험용 환경변수: JG_PORT(기본 4310) · JG_MODULES_DIR(부품 폴더, 기본 src/) · JG_LOG_PATH(기본 data/log.json)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, sep, basename, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadConfig, ROOT, DATA_DIR } from './config.mjs';
import { fetchLatestVideos } from './feed.mjs';
import { createRules, parseVideoId, classifyPostOutcome, testVideoIds, STAGE_LABEL } from './rules.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.JG_PORT || 4310);
const PUBLIC_DIR = join(ROOT, 'public');
const MODULES_DIR = process.env.JG_MODULES_DIR ? resolve(process.env.JG_MODULES_DIR) : join(ROOT, 'src');
const LOG_PATH = process.env.JG_LOG_PATH ? resolve(process.env.JG_LOG_PATH) : join(DATA_DIR, 'log.json');
const CAPTURE_DIR = join(DATA_DIR, 'captures');
const BODY_LIMIT = 64 * 1024; // 요청 본문 상한 — 댓글은 120자 남짓이라 넉넉히
const OEMBED_TIMEOUT_MS = 10000; // 테스트 영상 제목 조회 대기 상한

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ── 설정 ────────────────────────────────────────────────────────────
let lastGoodConfig = null;
function getConfig() {
  try {
    lastGoodConfig = loadConfig();
  } catch (e) {
    if (!lastGoodConfig) throw e;
    console.warn(`[config] config.json 을 읽지 못해 직전 설정을 씁니다: ${e.message}`);
  }
  return lastGoodConfig;
}

// ── 다른 담당 부품 ──────────────────────────────────────────────────
const MODULES = {
  collect: { file: 'collect.mjs', label: '영상 내용 읽기 부품' },
  ai: { file: 'ai.mjs', label: 'AI 초안 부품' },
  validate: { file: 'validate.mjs', label: '댓글 검사 부품' },
  post: { file: 'post.mjs', label: '댓글 게시 부품' },
};
const moduleExists = (name) => existsSync(join(MODULES_DIR, MODULES[name].file));

async function loadModule(name, fnName) {
  const m = MODULES[name];
  const path = join(MODULES_DIR, m.file);
  if (!existsSync(path)) {
    throw new AppError(503, 'MODULE_MISSING', `${m.label}(src/${m.file})이 아직 준비되지 않아 이 기능을 쓸 수 없습니다.`, { module: name });
  }
  let mod;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (e) {
    throw new AppError(503, 'MODULE_BROKEN', `${m.label}(src/${m.file})을 불러오다 오류가 났습니다: ${e.message}`, { module: name });
  }
  if (typeof mod[fnName] !== 'function') {
    throw new AppError(503, 'MODULE_INCOMPLETE', `${m.label}(src/${m.file})에 ${fnName} 기능이 없습니다.`, { module: name });
  }
  return mod[fnName];
}

// ── 상태 ────────────────────────────────────────────────────────────
let rules;
const metaCache = new Map(); // videoId → { videoId, title, channelId, channelName, publishedAt, thumbnail, url, source }
const ctxCache = new Map(); // videoId → VideoContext (다시 만들기 때 다시 읽지 않으려고)
const ctxInflight = new Map(); // videoId → Promise<VideoContext>
let currentJob = null; // 게시는 앱 전체에서 한 번에 하나
let lastJobEvent = null; // 새로 붙은 화면에 진행 중인 게시 상태를 보여 주려고

// ── SSE ─────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {}
  }
}

// ── 도우미 ──────────────────────────────────────────────────────────
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof AppError) {
    return sendJson(res, err.status, { ok: false, code: err.code, error: err.message, ...err.extra });
  }
  console.error('[server]', err);
  return sendJson(res, 500, { ok: false, code: 'INTERNAL', error: `서버 안에서 오류가 났습니다: ${err?.message || err}` });
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new AppError(415, 'BAD_CONTENT_TYPE', '요청은 JSON(application/json)으로 보내야 합니다.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new AppError(413, 'TOO_LARGE', '요청 내용이 너무 큽니다.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('객체가 아님');
    return data;
  } catch {
    throw new AppError(400, 'BAD_JSON', '요청 내용을 읽을 수 없습니다(JSON 형식 오류).');
  }
}

const videoUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

function publicMeta(m) {
  if (!m) return null;
  return {
    videoId: m.videoId,
    title: m.title || '',
    channelId: m.channelId || '',
    channelName: m.channelName || '',
    publishedAt: m.publishedAt || null,
    thumbnail: m.thumbnail || thumbUrl(m.videoId),
    views: m.views ?? null,
    url: m.url || videoUrl(m.videoId),
    isLive: m.isLive ?? undefined,
  };
}

/** 캡처 파일 경로 → 화면에서 열 수 있는 주소 (data/captures 안의 png 만) */
function captureUrl(p) {
  if (!p || typeof p !== 'string') return null;
  const full = isAbsolute(p) ? p : resolve(ROOT, p);
  if (!full.startsWith(CAPTURE_DIR + sep)) return null;
  return `/captures/${encodeURIComponent(basename(full))}`;
}

function publicEntry(e) {
  return { ...e, screenshotUrl: captureUrl(e.screenshot) };
}

/** 영상 정보 — 서버가 직접 받은 목록(지정 채널 RSS)에 있으면 그것, 없으면 collect.getVideoMeta 로 실제 채널을 확인 */
async function resolveMeta(videoId) {
  const cached = metaCache.get(videoId);
  if (cached && cached.channelId) return cached;
  // 테스트 영상은 ID 로 허용되므로, 채널을 몰라도 목록에서 받은 제목이 있으면 그대로 쓴다
  if (cached && testVideoIds(getConfig()).has(videoId) && !moduleExists('collect')) return cached;
  const getVideoMeta = await loadModule('collect', 'getVideoMeta');
  let meta;
  try {
    meta = await getVideoMeta(videoId);
  } catch (e) {
    throw new AppError(502, 'META_FAILED', `영상 정보를 읽지 못했습니다: ${e.message}`);
  }
  if (!meta || !meta.channelId) throw new AppError(502, 'META_FAILED', '영상 정보에서 채널을 확인하지 못했습니다.');
  const m = {
    ...cached,
    ...meta,
    videoId,
    url: videoUrl(videoId),
    thumbnail: meta.thumbnail || cached?.thumbnail || thumbUrl(videoId),
    source: 'meta',
  };
  metaCache.set(videoId, m);
  return m;
}

/** 테스트 영상 카드 — config.testVideos 에 제목이 적혀 있으면 그것, 없으면 키 없이 쓰는 oEmbed 로 제목·썸네일만. 실패해도 카드는 만든다 */
async function testVideoCard(videoId, item) {
  const cached = metaCache.get(videoId);
  if (cached && cached.title) return { ...publicMeta(cached), isTest: true };
  if (item && typeof item === 'object' && item.title) {
    const fromConfig = {
      videoId,
      title: String(item.title),
      channelId: item.channelId || '',
      channelName: item.channelName || '',
      publishedAt: item.publishedAt || null,
      thumbnail: item.thumbnail || thumbUrl(videoId),
      url: videoUrl(videoId),
    };
    metaCache.set(videoId, { ...fromConfig, source: 'config' });
    return { ...fromConfig, isTest: true };
  }
  let card = { videoId, title: '', channelId: '', channelName: '', publishedAt: null, thumbnail: thumbUrl(videoId), url: videoUrl(videoId) };
  try {
    const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl(videoId))}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
    if (r.ok) {
      const j = await r.json();
      card = { ...card, title: j.title || '', channelName: j.author_name || '', thumbnail: j.thumbnail_url || card.thumbnail };
    }
  } catch {}
  metaCache.set(videoId, { ...card, source: 'oembed' });
  return { ...card, isTest: true, note: card.title ? undefined : '제목을 불러오지 못했습니다' };
}

async function getContext(videoId, { fresh = false, emit } = {}) {
  if (!fresh && ctxCache.has(videoId)) return ctxCache.get(videoId);
  if (ctxInflight.has(videoId)) return ctxInflight.get(videoId);
  const collectVideoContext = await loadModule('collect', 'collectVideoContext');
  const p = (async () => {
    try {
      const ctx = await collectVideoContext(videoId, {
        onStatus: (stage, detail) => {
          const text = collectStatusText(stage, detail);
          if (text) emit?.('collect', text);
        },
      });
      ctxCache.set(videoId, ctx);
      return ctx;
    } catch (e) {
      throw new AppError(502, 'COLLECT_FAILED', `영상 내용(자막·설명·인기 댓글)을 읽지 못했습니다: ${e.message}`);
    } finally {
      ctxInflight.delete(videoId);
    }
  })();
  ctxInflight.set(videoId, p);
  return p;
}

// 수집 부품(collect.mjs)의 단계 알림 → 화면 문구. stage: opening | meta | comments | transcript | done | failed
function collectStatusText(stage, d) {
  d = d && typeof d === 'object' ? d : {};
  switch (stage) {
    case 'opening':
      return '영상 페이지를 뒤쪽 창에서 여는 중';
    case 'meta':
      return '영상 정보를 읽었습니다';
    case 'comments':
      return d.phase === 'end' ? `인기 댓글 ${d.count ?? 0}개를 읽었습니다` : '인기 댓글 읽는 중';
    case 'transcript':
      if (d.phase !== 'end') return '자막 읽는 중';
      return d.status === 'ok' ? '자막을 읽었습니다' : d.status === 'none' ? '이 영상엔 자막이 없습니다' : '자막을 가져오지 못했습니다';
    case 'done':
      return '영상 읽기 끝';
    case 'failed':
      return d.error ? `영상 읽기 실패: ${d.error}` : '영상 읽기 실패';
    default:
      return typeof stage === 'string' ? stage : '';
  }
}

// AI 부품(ai.mjs)의 단계 알림 → 화면 문구. stage: generating | checking | retry | done | failed
function aiStatusText(stage, d) {
  d = d && typeof d === 'object' ? d : {};
  switch (stage) {
    case 'generating':
      return `AI 가 영상 속 고민을 정리하고 댓글 초안을 쓰는 중${d.attempt > 1 ? ` (${d.attempt}/${d.maxAttempts}번째)` : ''}`;
    case 'checking':
      return '초안이 규칙에 맞는지 검사하는 중';
    case 'retry':
      return '규칙에 맞지 않아 다시 쓰는 중';
    default:
      return typeof stage === 'string' ? stage : '';
  }
}

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
function graphemes(s) {
  let n = 0;
  for (const _ of segmenter.segment(String(s ?? '').normalize('NFC'))) n++;
  return n;
}

/** 댓글 글 검사 — validate.mjs 가 있으면 그것(근거 인용 검사는 빼고 — evidence 를 넘기지 않음), 없으면 글자 수 · 줄바꿈 · 링크 · 해시태그만 */
async function checkText(text, videoId, meta, config) {
  const c = config.comment || {};
  const opts = { brand: c.brand, minChars: c.minChars, maxChars: c.maxChars, adLabel: c.adLabel === true };
  if (!text) return { ok: false, errors: ['댓글 내용이 비어 있습니다.'], by: 'server' };
  if (moduleExists('validate')) {
    const validateComment = await loadModule('validate', 'validateComment');
    const ctx = ctxCache.get(videoId) || {
      videoId,
      title: meta?.title || '',
      channelId: meta?.channelId || '',
      channelName: meta?.channelName || '',
      description: '',
      transcript: { status: 'none', lang: null, text: '', segments: [] },
      topComments: [],
    };
    const r = await validateComment(text, ctx, opts);
    return {
      ok: !!r?.ok,
      errors: Array.isArray(r?.errors) ? r.errors : [],
      warnings: Array.isArray(r?.warnings) ? r.warnings : [],
      by: 'validate',
    };
  }
  // validate.mjs 가 없을 때만 — 같은 셈법(최대=공백 포함, 최소=공백 빼고)으로 글자 수 · 줄바꿈 · 링크 · 해시태그
  const errors = [];
  const withSpaces = graphemes(text);
  const withoutSpaces = graphemes(text.replace(/\s+/gu, ''));
  if (Number.isFinite(opts.maxChars) && withSpaces > opts.maxChars) errors.push(`댓글이 공백 포함 ${withSpaces}자로 ${opts.maxChars}자를 넘습니다.`);
  if (Number.isFinite(opts.minChars) && withoutSpaces < opts.minChars) errors.push(`댓글이 공백 빼고 ${withoutSpaces}자로 ${opts.minChars}자보다 짧습니다.`);
  if (/[\r\n\u2028\u2029]/.test(text)) errors.push('댓글에 줄바꿈이 있습니다. 한 줄로 이어 쓰세요.');
  if (/(https?:\/\/|www\.)/i.test(text)) errors.push('댓글에 링크를 넣을 수 없습니다.');
  if (/[#＃]\S/u.test(text)) errors.push('댓글에 해시태그를 넣을 수 없습니다.');
  return { ok: errors.length === 0, errors, by: 'server' };
}

// ── API ─────────────────────────────────────────────────────────────
async function apiConfig(req, res) {
  const c = getConfig();
  sendJson(res, 200, {
    ok: true,
    channels: (c.channels || []).map((x) => ({ id: x.id, name: x.name })),
    testVideos: [...testVideoIds(c)],
    profiles: (c.profiles || []).map((p) => ({ id: p.id, name: p.name || p.id })),
    comment: { minChars: c.comment?.minChars ?? null, maxChars: c.comment?.maxChars ?? null, brand: c.comment?.brand || '' },
    limits: { dailyMaxComments: rules.todayStatus().max },
    typing: { delayMs: c.typing?.delayMs ?? null },
    modules: Object.fromEntries(Object.keys(MODULES).map((k) => [k, moduleExists(k)])),
    today: rules.todayStatus(),
    busy: currentJob ? { videoId: currentJob.videoId, dryRun: currentJob.dryRun } : null,
  });
}

async function apiLog(req, res) {
  sendJson(res, 200, { ok: true, entries: rules.entries().map(publicEntry), today: rules.todayStatus() });
}

async function apiVideos(req, res) {
  const c = getConfig();
  const { videos, errors } = await fetchLatestVideos(c.channels || []);
  for (const v of videos) metaCache.set(v.videoId, { ...v, source: 'feed' });
  const testItems = new Map(); // videoId → config 항목 (같은 영상이 두 번 적혀도 카드는 하나)
  for (const item of c.testVideos || []) {
    const raw = typeof item === 'string' ? item : item?.videoId || item?.id || item?.url;
    const id = parseVideoId(String(raw ?? ''));
    if (id && !testItems.has(id)) testItems.set(id, item);
  }
  const tests = await Promise.all([...testItems].map(([id, item]) => testVideoCard(id, item)));
  const withLock = (v) => ({ ...v, lock: rules.lockOf(v.videoId) });
  sendJson(res, 200, {
    ok: true,
    testVideos: tests.map(withLock),
    videos: videos.map(publicMeta).map(withLock),
    errors,
    fetchedAt: new Date().toISOString(),
    today: rules.todayStatus(),
  });
}

async function apiDraft(req, res) {
  const body = await readJson(req);
  const raw = body.videoId ?? body.url ?? '';
  const videoId = parseVideoId(String(raw));
  if (!videoId) {
    throw new AppError(400, 'BAD_INPUT', '유튜브 영상 링크나 영상 ID 를 알아볼 수 없습니다. 예: https://youtu.be/akn-AvCeHBI 또는 https://www.youtube.com/watch?v=akn-AvCeHBI');
  }
  const requestId = typeof body.requestId === 'string' ? body.requestId : randomUUID();
  const emit = (stage, label) => broadcast('draft', { requestId, videoId, stage, label });
  const c = getConfig();

  try {
    emit('meta', '영상 정보·채널 확인 중');
    const meta = await resolveMeta(videoId);
    const allowed = rules.checkAllowed(meta);
    if (!allowed.ok) throw new AppError(403, 'NOT_ALLOWED', allowed.reason, { videoId, meta: publicMeta(meta) });

    // AI 부품이 없으면 영상을 읽기 전에 알린다
    const generateDraft = await loadModule('ai', 'generateDraft');
    if (!ctxCache.has(videoId)) emit('collect', '자막·설명·인기 댓글 읽는 중');
    // [다시 만들기] 때 지난번 자막을 못 읽었으면 영상을 다시 읽는다(자막을 이번엔 읽을 수도 있다)
    const retryTranscript = body.regenerate === true && ctxCache.get(videoId)?.transcript?.status === 'failed';
    const ctx = await getContext(videoId, { fresh: body.fresh === true || retryTranscript, emit });

    // 수집 결과의 채널로 한 번 더 확인 (목록 정보와 실제 영상이 다를 때 대비)
    if (ctx?.channelId && ctx.channelId !== meta.channelId) {
      const again = rules.checkAllowed({ ...meta, channelId: ctx.channelId, channelName: ctx.channelName });
      if (!again.ok) throw new AppError(403, 'NOT_ALLOWED', again.reason, { videoId });
    }

    emit('ai', 'AI 가 영상 속 고민을 정리하고 댓글 초안을 쓰는 중');
    let draft;
    try {
      draft = await generateDraft(ctx, {
        brand: c.comment?.brand,
        minChars: c.comment?.minChars,
        maxChars: c.comment?.maxChars,
        adLabel: c.comment?.adLabel === true,
        onStatus: (stage, detail) => {
          if (stage === 'done' || stage === 'failed') return; // 끝 알림은 아래에서 한 번만
          if (stage === 'generating' && detail?.attempt === 1) return; // 첫 생성 알림은 위에서 이미 보냄
          emit('ai', aiStatusText(stage, detail));
        },
      });
    } catch (e) {
      throw new AppError(502, 'AI_FAILED', `AI 가 초안을 만들지 못했습니다: ${e.message}`);
    }
    // ai.mjs 는 실패해도 예외 대신 { ok:false, error, comment(마지막 시도) } 를 돌려준다 — 글이 아예 없을 때만 오류
    if (!draft || (draft.ok === false && !draft.comment)) {
      throw new AppError(502, 'AI_FAILED', `AI 가 초안을 만들지 못했습니다: ${draft?.error || '이유를 알 수 없습니다'}`);
    }
    let check = null;
    if (draft?.comment) {
      try {
        check = await checkText(String(draft.comment), videoId, meta, c);
      } catch (e) {
        check = { ok: false, errors: [`댓글 검사를 하지 못했습니다: ${e.message}`], by: 'error' };
      }
    }
    emit('done', '초안 완성');

    const merged = {
      ...meta,
      title: meta.title || ctx?.title || '',
      channelName: meta.channelName || ctx?.channelName || '',
    };
    sendJson(res, 200, {
      ok: true,
      requestId,
      videoId,
      meta: publicMeta(merged),
      allowedBy: allowed.via,
      draft,
      draftError: draft.ok === false ? draft.error || '초안이 규칙 검사를 통과하지 못했습니다.' : null,
      check,
      source: {
        transcript: ctx?.transcript?.status || null,
        transcriptLang: ctx?.transcript?.lang || null,
        transcriptError: ctx?.transcript?.error || null,
        topComments: Array.isArray(ctx?.topComments) ? ctx.topComments.length : 0,
        hasDescription: Boolean(ctx?.description),
      },
      lock: rules.lockOf(videoId),
      today: rules.todayStatus(),
    });
  } catch (e) {
    emit('failed', e.message);
    throw e;
  }
}

const RULE_STATUS = { BAD_INPUT: 400, EMPTY_TEXT: 400, NOT_ALLOWED: 403, IN_PROGRESS: 409, ALREADY_COMMENTED: 409, DAILY_LIMIT: 429, LOG_WRITE_FAILED: 500 };

async function apiPost(req, res) {
  const body = await readJson(req);
  const videoId = parseVideoId(String(body.videoId ?? body.url ?? ''));
  if (!videoId) throw new AppError(400, 'BAD_INPUT', '어느 영상에 달지 알 수 없습니다(영상 ID 없음).');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const dryRun = body.dryRun !== false; // 명시적으로 false 일 때만 실제 게시
  const c = getConfig();
  const profiles = c.profiles || [];
  const profile = body.profileId ? profiles.find((p) => p.id === body.profileId) : profiles[0];
  if (!profile) throw new AppError(400, 'BAD_PROFILE', `프로필을 찾을 수 없습니다: ${body.profileId || '(설정에 프로필 없음)'}`);

  // 동시에 두 번 눌러도 하나만 — 본문을 다 읽은 직후, 비동기 작업 전에 동기로 자리를 잡는다
  if (currentJob) {
    throw new AppError(409, 'BUSY', `지금 다른 댓글을 ${currentJob.dryRun ? '연습' : '다는'} 중입니다. 끝난 뒤 다시 눌러 주세요.`);
  }
  const jobId = randomUUID();
  currentJob = { jobId, videoId, dryRun, startedAt: new Date().toISOString() };

  try {
    const postComment = await loadModule('post', 'postComment');
    const meta = await resolveMeta(videoId);
    const allowed = rules.checkAllowed(meta);
    if (!allowed.ok) throw new AppError(403, 'NOT_ALLOWED', allowed.reason, { videoId });

    const check = await checkText(text, videoId, meta, c);
    if (!check.ok) throw new AppError(422, 'INVALID_TEXT', `댓글이 규칙에 맞지 않습니다: ${check.errors.join(' ')}`, { errors: check.errors });

    const r = rules.reserve({ meta, profile, text, dryRun });
    if (!r.ok) throw new AppError(RULE_STATUS[r.code] || 409, r.code, r.reason, { videoId });
    broadcast('log', { reason: 'reserved', today: rules.todayStatus() });

    const base = { jobId, videoId, dryRun, title: meta.title || '', profileName: profile.name || profile.id };
    const seenStages = [];
    const emitPost = (stage, detail) => {
      if (typeof stage === 'string' && stage !== 'failed') seenStages.push(stage);
      let label = stage === 'start' ? '시작' : STAGE_LABEL[stage] || String(stage);
      // post.mjs 는 결과불명도 'failed' + detail.outcome:'unknown' 으로 알린다
      if (stage === 'failed' && detail?.outcome === 'unknown') label = '결과불명';
      const ev = { ...base, stage, detail: detail ?? null, label };
      lastJobEvent = ev;
      broadcast('post', ev);
    };
    emitPost('start', null);

    let result = null;
    let error = null;
    try {
      result = await postComment({
        videoId,
        text,
        dryRun,
        delayMs: c.typing?.delayMs,
        onStatus: (stage, detail) => emitPost(stage, detail),
        // 계약 밖 추가 정보 — 프로필이 여럿일 때 게시 부품이 쓸 수 있게
        profile,
        cdpPort: profile.cdpPort,
      });
    } catch (e) {
      error = e;
    }

    const outcome = classifyPostOutcome({ dryRun, result, error, seenStages });
    const entry = rules.finish(r.reservation, {
      result: outcome.result,
      reason: outcome.reason,
      stage: result?.stage || seenStages[seenStages.length - 1] || null,
      screenshot: result?.screenshot ? (isAbsolute(result.screenshot) ? relative(ROOT, result.screenshot) : result.screenshot) : null,
      commentUrl: result?.commentUrl || (outcome.result === 'success' ? videoUrl(videoId) : null),
      authorName: result?.authorName,
    });
    const pub = publicEntry(entry);
    const practiceOk = dryRun && !error && !!result?.ok;
    const ok = outcome.result === 'success' || practiceOk;
    const final = { ...base, stage: ok ? 'done' : 'failed', final: true, ok, entry: pub, label: entry.resultLabel };
    lastJobEvent = final;
    broadcast('post', final);
    broadcast('log', { reason: 'finished', today: rules.todayStatus() });
    sendJson(res, 200, { ok, jobId, entry: pub, today: rules.todayStatus() });
  } finally {
    currentJob = null;
  }
}

function apiEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ today: rules.todayStatus(), job: currentJob ? lastJobEvent : null })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// ── 정적 파일 ───────────────────────────────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'",
  "img-src 'self' https://*.ytimg.com https://*.ggpht.com data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

async function serveFile(res, baseDir, relPath) {
  const base = resolve(baseDir);
  const full = resolve(base, '.' + relPath);
  if (!full.startsWith(base + sep)) return notFound(res);
  let data;
  try {
    data = await readFile(full);
  } catch {
    return notFound(res);
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
  });
  res.end(data);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('찾을 수 없습니다');
}

// ── 라우터 ──────────────────────────────────────────────────────────
const ROUTES = {
  'GET /api/config': apiConfig,
  'GET /api/log': apiLog,
  'GET /api/videos': apiVideos,
  'POST /api/draft': apiDraft,
  'POST /api/post': apiPost,
};

async function handle(req, res) {
  // 다른 사이트가 이 PC 의 대시보드를 몰래 부르지 못하게 — 주소(Host)와 출처(Origin)를 본다
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('허용되지 않은 주소로 접근했습니다');
  }
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && !ALLOWED_ORIGINS.has(origin)) {
    return sendJson(res, 403, { ok: false, code: 'BAD_ORIGIN', error: '다른 사이트에서 보낸 요청은 받지 않습니다.' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  } catch {
    return notFound(res);
  }

  try {
    if (pathname === '/api/events' && req.method === 'GET') return apiEvents(req, res);
    const route = ROUTES[`${req.method} ${pathname}`];
    if (route) return await route(req, res);
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, code: 'NO_ROUTE', error: `없는 API 입니다: ${req.method} ${pathname}` });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    if (pathname.startsWith('/captures/')) {
      const name = basename(pathname);
      if (!/^[\w.\-]+\.png$/i.test(name)) return notFound(res);
      return await serveFile(res, CAPTURE_DIR, '/' + name);
    }
    return await serveFile(res, PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  } catch (e) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    return sendError(res, e);
  }
}

// ── 시작 ────────────────────────────────────────────────────────────
try {
  getConfig();
  rules = createRules({ getConfig, logPath: LOG_PATH });
} catch (e) {
  console.error(`시작하지 못했습니다: ${e.message}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${PORT} 를 이미 다른 프로그램이 쓰고 있습니다. 대시보드가 이미 켜져 있는지 확인하세요.`);
  else console.error(`서버 오류: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const mods = Object.keys(MODULES)
    .map((k) => `${MODULES[k].file}:${moduleExists(k) ? '있음' : '없음'}`)
    .join(' · ');
  const t = rules.todayStatus();
  console.log(`대시보드: http://${HOST}:${PORT}`);
  console.log(`부품: ${mods}`);
  console.log(`기록: ${relative(ROOT, LOG_PATH) || LOG_PATH} · 오늘 게시 ${t.count}/${t.max}`);
});

// 끌 때: 게시 중이었다면 기록에 '진행 중' 으로 남고, 다음 시작 때 결과불명으로 확정된다(rules.mjs).
// 크롬 전용 프로필을 띄웠다면 닫는다 — docs/contracts.md 변경 공지 "서버를 끌 때 closeAll()". 두 번째 신호는 바로 끈다.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  for (const r of sseClients) {
    try {
      r.end();
    } catch {}
  }
  const browserPath = join(MODULES_DIR, 'browser.mjs');
  if (existsSync(browserPath)) {
    try {
      const { closeAll } = await import(pathToFileURL(browserPath).href);
      if (typeof closeAll === 'function') await closeAll();
    } catch (e) {
      console.error(`[server] 크롬 프로필을 닫지 못했습니다: ${e.message}`);
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // Windows 에서 콘솔 창을 닫을 때
