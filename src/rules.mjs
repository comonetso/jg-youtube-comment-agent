// 운영 규칙 — 서버가 게시 전에 반드시 거치는 관문.
// 화면 버튼을 막는 것과 별개로 여기서 강제한다(과제 "운영 규칙 — 코드에서 강제").
//
//  - 허용 범위: config.channels 의 채널 영상 또는 config.testVideos 의 영상만
//  - 영상당 댓글 1개: 성공·결과불명·진행 중이면 잠금, 확실한 실패만 풀림
//  - 하루 상한: config.limits.dailyMaxComments (앱 전체, PC 로컬 날짜). 성공·결과불명·진행 중을 센다
//  - 게시 직전 예약: reserve() 는 동기 함수라 같은 프로세스 안에서 동시에 두 번 불러도 하나만 통과한다
//  - 시간순 기록: data/log.json (배열). 예약할 때 '진행 중' 으로 먼저 적고, 끝나면 결과로 바꾼다
//  - 연습(dryRun): 기록은 남기되 잠금·상한에는 넣지 않는다
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RESULT_LABEL = {
  success: '성공',
  failed: '실패',
  unknown: '결과불명',
  practice: '연습',
  pending: '진행 중',
};

// 잠금·상한에 들어가는 결과 (연습 제외, 실제 게시 요청만)
const COUNTED = new Set(['success', 'unknown', 'pending']);

// 게시 부품(post.mjs)이 알리는 단계 순서 — docs/contracts.md "게시" 절
export const STAGE_ORDER = ['opening', 'loading', 'typing', 'posting', 'verifying', 'done'];
export const STAGE_LABEL = {
  opening: '프로필 여는 중',
  loading: '영상·댓글 창 여는 중',
  typing: '입력 중',
  posting: '게시 중',
  verifying: '내 댓글 확인 중',
  done: '완료',
  failed: '실패',
};

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** 링크·ID 를 영상 ID(11자)로 바꾼다. youtu.be/ · watch?v= · shorts/ · live/ · embed/ · 그냥 ID. 못 알아보면 null. */
export function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (ID_RE.test(s)) return s;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] || null;
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(shorts|live|embed|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

/** config.testVideos → 영상 ID 집합. 항목은 ID·링크 문자열 또는 { videoId | id | url } 객체를 받는다. */
export function testVideoIds(config) {
  const ids = new Set();
  for (const item of config?.testVideos || []) {
    const raw = typeof item === 'string' ? item : item?.videoId || item?.id || item?.url;
    const id = parseVideoId(String(raw ?? ''));
    if (id) ids.add(id);
  }
  return ids;
}

/** PC 로컬 날짜 'YYYY-MM-DD' */
export function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 사람이 읽는 PC 로컬 시각 'MM.DD HH:mm' */
export function localTimeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 과제 원문 "하루 게시 상한 (기본 10개)" — config 에 값이 없을 때만 10 */
export function dailyMax(config) {
  const n = Number(config?.limits?.dailyMaxComments);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/**
 * 게시 결과를 기록용 결과로 가른다.
 *  - 연습 → practice
 *  - 확인됨(verified) → success
 *  - ok 인데 확인 못 함 → unknown
 *  - 게시 부품이 알려 준 신호가 있으면 먼저 쓴다 (src/post.mjs 의 계약 밖 필드):
 *      submitted === true 또는 outcome === 'unknown' → unknown (제출은 눌렀다)
 *      submitted === false 이고 outcome === 'failed' → failed (제출 버튼을 누르지 않았다)
 *  - 신호가 없으면 단계로 가른다: 마지막으로 도달한 단계가 'posting' 전이면 failed(확실한 실패), 'posting' 이후면 unknown
 *    단계 정보가 전혀 없고 예외만 났으면 failed(게시 단계에 들어가기 전), 결과만 있고 단계를 모르면 unknown(보수적)
 */
export function classifyPostOutcome({ dryRun, result, error, seenStages = [] } = {}) {
  const errMsg = error?.message || (typeof error === 'string' ? error : '') || result?.error || '';
  if (dryRun) {
    if (!error && result?.ok) return { result: 'practice', reason: '연습 완료 — 입력까지만 하고 게시 버튼은 누르지 않았습니다.' };
    return { result: 'practice', reason: `연습 중 멈춤: ${errMsg || '이유를 알 수 없습니다'}` };
  }
  if (!error && result?.verified === true) {
    return { result: 'success', reason: '게시 후 내 댓글이 보이는 것을 확인했습니다.' };
  }
  if (!error && result?.ok) {
    return {
      result: 'unknown',
      reason: `게시는 했지만 내 댓글이 보이는지 확인하지 못했습니다${errMsg ? ` (${errMsg})` : ''}. 같은 영상에 다시 달지 않도록 잠급니다.`,
    };
  }
  if (result?.submitted === true || result?.outcome === 'unknown') {
    return {
      result: 'unknown',
      reason: `${errMsg || '제출은 눌렀지만 결과를 확인하지 못했습니다'} — 실제로 달렸을 수 있어 같은 영상에 다시 달지 않도록 잠급니다.`,
    };
  }
  if (!error && result?.submitted === false && result?.outcome === 'failed') {
    const where = STAGE_LABEL[result.stage] || result.stage || '';
    return { result: 'failed', reason: `${errMsg || '이유를 알 수 없습니다'} (제출 버튼을 누르기 전${where ? `, '${where}' 단계` : ''}에서 멈춤)` };
  }
  let furthest = -1;
  let known = false;
  for (const s of [...seenStages, result?.stage]) {
    const i = STAGE_ORDER.indexOf(s);
    if (i >= 0) {
      known = true;
      furthest = Math.max(furthest, i);
    }
  }
  const POSTING = STAGE_ORDER.indexOf('posting');
  if (known && furthest < POSTING) {
    const where = STAGE_LABEL[STAGE_ORDER[furthest]];
    return { result: 'failed', reason: `${errMsg || '이유를 알 수 없습니다'} (게시 버튼을 누르기 전, '${where}' 단계에서 멈춤)` };
  }
  if (!known && error && !result) {
    return { result: 'failed', reason: `${errMsg || '이유를 알 수 없습니다'} (게시 단계에 들어가기 전에 멈춤)` };
  }
  return {
    result: 'unknown',
    reason: `${errMsg || '이유를 알 수 없습니다'} — 게시 버튼을 눌렀을 수 있어 같은 영상에 다시 달지 않도록 잠급니다.`,
  };
}

/**
 * 규칙 관문을 만든다.
 * @param {{ getConfig: (() => object) | object, logPath: string, now?: () => Date }} opts
 */
export function createRules({ getConfig, logPath, now = () => new Date() }) {
  if (!logPath) throw new Error('logPath 가 필요합니다');
  const cfg = () => (typeof getConfig === 'function' ? getConfig() : getConfig) || {};

  let entries = load();

  // 앱이 게시 도중 꺼졌던 흔적('진행 중' 그대로 남은 기록)은 결과불명으로 확정한다 — 실제로 달렸을 수 있다.
  let stale = false;
  for (const e of entries) {
    if (e.result !== 'pending') continue;
    stale = true;
    e.result = e.dryRun ? 'practice' : 'unknown';
    e.resultLabel = RESULT_LABEL[e.result];
    e.reason = e.dryRun
      ? '연습 도중 앱이 꺼졌습니다.'
      : '게시 도중 앱이 꺼져 결과를 확인하지 못했습니다. 같은 영상에 다시 달지 않도록 잠급니다.';
    e.finishedAt = now().toISOString();
  }
  if (stale) save();

  function load() {
    if (!existsSync(logPath)) return [];
    let data;
    try {
      data = JSON.parse(readFileSync(logPath, 'utf8'));
    } catch (e) {
      // 기록이 깨진 채로 시작하면 잠금·상한을 잃는다 — 시작하지 않는다.
      throw new Error(`기록 파일(${logPath})을 읽을 수 없어 규칙을 지킬 수 없습니다. 파일을 확인해 주세요. (${e.message})`);
    }
    if (!Array.isArray(data)) throw new Error(`기록 파일(${logPath})의 모양이 배열이 아닙니다.`);
    return data;
  }

  function save() {
    mkdirSync(dirname(logPath), { recursive: true });
    const body = JSON.stringify(entries, null, 2);
    const tmp = `${logPath}.tmp`;
    try {
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, logPath);
    } catch {
      // OneDrive 동기화 등으로 이름 바꾸기가 막히면 직접 쓴다. 이것도 실패하면 예외 — 호출한 쪽이 게시를 막는다.
      writeFileSync(logPath, body, 'utf8');
    }
  }

  function checkAllowed(meta) {
    const c = cfg();
    const videoId = meta?.videoId;
    if (videoId && testVideoIds(c).has(videoId)) return { ok: true, via: 'testVideo' };
    const ch = (c.channels || []).find((x) => x.id === meta?.channelId);
    if (ch) return { ok: true, via: 'channel', channelName: ch.name };
    const names = (c.channels || []).map((x) => x.name).join(', ');
    if (!meta?.channelId) {
      return { ok: false, code: 'NOT_ALLOWED', reason: '이 영상의 채널을 확인하지 못해 허용 여부를 판단할 수 없습니다. 게시하지 않습니다.' };
    }
    return {
      ok: false,
      code: 'NOT_ALLOWED',
      reason: `허용된 채널의 영상이 아닙니다. 이 영상의 채널: ${meta.channelName || '이름 모름'} (${meta.channelId}). 댓글을 달 수 있는 채널: ${names}`,
    };
  }

  /** 이 영상을 잠그는 기록(성공·결과불명·진행 중, 연습 제외). 없으면 null */
  function lockOf(videoId) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.videoId === videoId && !e.dryRun && COUNTED.has(e.result)) return e;
    }
    return null;
  }

  function publicLock(videoId) {
    const e = lockOf(videoId);
    if (!e) return null;
    return { result: e.result, label: RESULT_LABEL[e.result], time: e.time, profileId: e.profileId, profileName: e.profileName };
  }

  function todayStatus() {
    const date = localDateKey(now());
    const max = dailyMax(cfg());
    const count = entries.filter((e) => !e.dryRun && e.date === date && COUNTED.has(e.result)).length;
    return { date, count, max, remaining: Math.max(0, max - count) };
  }

  const fail = (code, reason) => ({ ok: false, code, reason });

  /**
   * 게시 직전 예약. 통과하면 '진행 중' 기록을 파일에 먼저 쓰고 돌려준다.
   * 동기 함수 — 검사와 기록 추가 사이에 다른 요청이 끼어들 수 없다.
   */
  function reserve({ meta, profile, text, dryRun } = {}) {
    dryRun = dryRun !== false; // 명시적으로 false 일 때만 실제 게시
    const videoId = meta?.videoId;
    if (!videoId || !ID_RE.test(videoId)) return fail('BAD_INPUT', '영상 ID 가 올바르지 않습니다.');
    const allowed = checkAllowed(meta);
    if (!allowed.ok) return allowed;
    if (typeof text !== 'string' || !text.trim()) return fail('EMPTY_TEXT', '댓글 내용이 비어 있습니다.');

    const active = entries.find((e) => e.videoId === videoId && e.result === 'pending');
    if (active) return fail('IN_PROGRESS', '이 영상은 지금 다른 요청이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.');

    if (!dryRun) {
      const lock = lockOf(videoId);
      if (lock) {
        return fail(
          'ALREADY_COMMENTED',
          `이 영상에는 이미 댓글을 달았습니다(${RESULT_LABEL[lock.result]} · ${localTimeText(lock.time)} · ${lock.profileName || lock.profileId || '프로필 모름'}). 영상당 댓글은 1개만 답니다.`,
        );
      }
      const t = todayStatus();
      if (t.count >= t.max) {
        return fail('DAILY_LIMIT', `오늘 게시 상한(${t.max}개)에 도달했습니다. PC 날짜가 바뀌면 다시 할 수 있습니다.`);
      }
    }

    const at = now();
    const entry = {
      id: randomUUID(),
      time: at.toISOString(),
      date: localDateKey(at),
      videoId,
      title: meta.title || '',
      channelId: meta.channelId || '',
      channelName: meta.channelName || '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      profileId: profile?.id || '',
      profileName: profile?.name || '',
      comment: text,
      dryRun,
      allowedBy: allowed.via,
      result: 'pending',
      resultLabel: RESULT_LABEL.pending,
      reason: '',
      stage: null,
      screenshot: null,
      commentUrl: null,
      finishedAt: null,
    };
    entries.push(entry);
    try {
      save();
    } catch (e) {
      entries.pop();
      return fail('LOG_WRITE_FAILED', `기록 파일에 쓰지 못해 게시하지 않습니다. (${e.message})`);
    }
    return { ok: true, reservation: { id: entry.id, videoId, dryRun }, entry: { ...entry } };
  }

  /** 예약을 결과로 확정한다. outcome.result: success | failed | unknown (연습 예약은 항상 practice) */
  function finish(reservation, outcome = {}) {
    const id = typeof reservation === 'string' ? reservation : reservation?.id;
    const e = entries.find((x) => x.id === id);
    if (!e) throw new Error(`예약을 찾을 수 없습니다: ${id}`);
    if (e.result !== 'pending') return { ...e };
    let result = e.dryRun ? 'practice' : outcome.result;
    if (!RESULT_LABEL[result] || result === 'pending' || (result === 'practice' && !e.dryRun)) result = 'unknown';
    Object.assign(e, {
      result,
      resultLabel: RESULT_LABEL[result],
      reason: outcome.reason || '',
      stage: outcome.stage ?? null,
      screenshot: outcome.screenshot ?? null,
      commentUrl: outcome.commentUrl ?? null,
      authorName: outcome.authorName ?? undefined,
      finishedAt: now().toISOString(),
    });
    try {
      save();
    } catch (err) {
      // 파일에는 '진행 중' 으로 남는다 → 다음 시작 때 결과불명으로 확정된다(보수적). 메모리 상태는 이미 갱신됐다.
      console.error(`[rules] 결과를 기록 파일에 쓰지 못했습니다: ${err.message}`);
    }
    return { ...e };
  }

  return {
    checkAllowed,
    lockOf: publicLock,
    todayStatus,
    reserve,
    finish,
    entries: () => entries.map((e) => ({ ...e })),
  };
}
