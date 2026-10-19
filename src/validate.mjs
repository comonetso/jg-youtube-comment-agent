// 댓글 초안 검사 — 과제 규칙(40~120자 · 링크/해시태그 금지 · 지어낸 후기 금지 · 영상 속 말 인용)을 코드로 확인한다.
// validateComment(text, ctx, { brand, minChars, maxChars, evidence }) → { ok, errors, warnings, length, evidence }
//   errors   : 한국어 문장. 하나라도 있으면 ok=false (AI 는 이 문장을 받아 다시 쓴다)
//   warnings : 막지는 않는 참고 사항
//   evidence : opts.evidence 를 원문에서 찾아 확인한 결과(자막이면 실제 시각 t 를 채움)
// opts.evidence 가 없으면(사람이 고친 글 등) 인용 확인은 건너뛰고 나머지 규칙만 본다.

const SOURCES = ['transcript', 'description', 'title', 'comment'];
const SOURCE_KO = { transcript: '자막', description: '설명', title: '제목', comment: '인기 댓글' };

// 인용으로 인정하는 최소 길이(공백·문장부호 제외 글자 수). 너무 짧으면 어디에나 있는 말이라 '구체적 장면'이 못 된다.
export const MIN_QUOTE_CHARS = 4;

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
/** 사람이 보는 글자 수(한글 한 글자·이모지 하나 = 1). */
export function countChars(s) {
  let n = 0;
  for (const _ of segmenter.segment(String(s ?? '').normalize('NFC'))) n++;
  return n;
}

/** 비교용 정규화 — 공백·문장부호·기호·보이지 않는 문자를 지우고 소문자로. */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{Cf}]/gu, '');
}

// ── 링크·도메인 ────────────────────────────────────────────
const LINK_PATTERNS = [
  { re: /https?:\/\//i, why: '인터넷 주소(http)' },
  { re: /\bwww\./i, why: '인터넷 주소(www)' },
  // 낱말.영문최상위도메인 (예: abc.com, 운명원.kr, youtu.be, bit.ly) — 점 앞뒤 공백 없이 붙은 것
  { re: /[\p{L}\p{N}_-]+\.[a-z]{2,}(?![\p{L}])/iu, why: '도메인 형태(○○.com 등)' },
  // 점 앞뒤를 띄워 피한 흔한 최상위 도메인 (예: 운명원 . com)
  { re: /[\p{L}\p{N}]\s*\.\s*(?:com|net|org|kr|co|io|me|ly|be|gl|shop|site|xyz)(?![\p{L}])/iu, why: '도메인 형태(○○ . com 등)' },
  { re: /(닷컴|닷넷|닷케이알|점컴|dot\s*com)/i, why: '주소를 풀어 쓴 표현(닷컴 등)' },
];

// ── 지어낸 이용 후기(체험 서술) ─────────────────────────────
// 들은 말("잘 본다던데")·바람("보고 싶다")은 허용, 직접 해 본 것처럼 쓰는 말은 막는다.
// '점'은 앞에 글자가 붙으면(장점·단점) 제외
const SERVICE = '(?:사주|궁합|연애운|운세|(?<![\\p{L}])점|타로|상담|풀이)';
const FAKE_REVIEW_PATTERNS = [
  // 사주·상담 등을 받아 봤다 / 보고 왔다
  new RegExp(`${SERVICE}\\s*(?:을|를|도|은|는)?\\s*(?:받아\\s*봤|받아\\s*보니|받았|보고\\s*왔|봤는데|봤더니|봤었|봐\\s*봤|해\\s*봤|봤어요|봤습니다|봤다)`, 'u'),
  // 가 봤다 · 보러 갔다 · 다녀왔다 · 방문/예약/결제/상담 받음 (남의 일화로 꾸며도 지어낸 후기다)
  /(?:가\s*봤|가\s*보니|보러\s*갔|보러\s*다녀|다녀\s*왔|다녀\s*온|방문했|방문해\s*봤|예약했|결제했|상담\s*받았|상담\s*받아\s*봤|상담\s*받고)/u,
  // (사주·운명원·거기·선생님…) 이 맞더라 / 맞췄다 / 정확하더라 / 용하더라
  new RegExp(`(?:${SERVICE}|운명원|거기|그곳|여기|선생님|쌤)[^.!?\\n]{0,15}(?:맞더라|맞았|맞췄|맞추더|맞혔|정확하더|정확했|용하더|용했|소름\\s*돋았)`, 'u'),
  // 운명원 + 직접 이용 서술
  /운명원[^.!?\n]{0,20}(?:봤는데|봤더니|봤어요|봤습니다|받았는데|받아\s*봤|가\s*봤|다녀|써\s*봤|이용해\s*봤|이용했|해\s*봤|덕분|덕에)/u,
  // 후기를 남긴다 · 내돈내산 · 추천한다(써 본 사람의 말). "추천한다던데·강추하던데" 같은 들은 말은 제외
  /(?:후기\s*(?:남|올|씁|써|입니다|예요|에요)|내돈내산|강추(?![하라]던|한다던|래)|추천\s*(?:합니다|해요|드려요|드립니다|함(?![\p{L}])|한다(?![던고]|더)))/u,
];

function lengthCheck(text, minChars, maxChars, errors) {
  const withSpaces = countChars(text);
  const withoutSpaces = countChars(text.replace(/\s+/gu, ''));
  if (withSpaces > maxChars) errors.push(`댓글이 공백 포함 ${withSpaces}자로 ${maxChars}자를 넘습니다. ${withSpaces - maxChars}자 이상 줄이세요.`);
  if (withoutSpaces < minChars) errors.push(`댓글이 공백 빼고 ${withoutSpaces}자로 ${minChars}자보다 짧습니다. ${minChars - withoutSpaces}자 이상 늘리세요.`);
  return { withSpaces, withoutSpaces, min: minChars, max: maxChars };
}

/** 원문 안에서 인용을 찾는다. 자막이면 그 말이 시작되는 줄의 시각(초)을 돌려준다. */
export function locateQuote(quote, source, ctx) {
  const q = normalize(quote);
  if (!q) return { found: false };
  if (source === 'title') return { found: normalize(ctx?.title).includes(q), t: null };
  if (source === 'description') return { found: normalize(ctx?.description).includes(q), t: null };
  if (source === 'comment') {
    const list = Array.isArray(ctx?.topComments) ? ctx.topComments : [];
    const idx = list.findIndex((c) => normalize(c?.text).includes(q));
    return { found: idx >= 0, t: null, commentIndex: idx >= 0 ? idx : undefined };
  }
  if (source === 'transcript') {
    const tr = ctx?.transcript || {};
    const segs = Array.isArray(tr.segments) ? tr.segments : [];
    if (segs.length) {
      // 줄들을 이어 붙인 정규화 문자열 + 글자 위치 → 몇 번째 줄인지 표
      let joined = '';
      const owner = [];
      segs.forEach((s, i) => {
        const n = normalize(s?.text);
        joined += n;
        for (let k = 0; k < n.length; k++) owner.push(i);
      });
      const at = joined.indexOf(q);
      if (at >= 0) {
        const t = Number(segs[owner[at]]?.t);
        return { found: true, t: Number.isFinite(t) ? t : null };
      }
    }
    // 줄 정보가 없거나 줄로는 못 찾으면 전체 글에서 (시각은 모름)
    return { found: normalize(tr.text).includes(q), t: null };
  }
  return { found: false };
}

function evidenceCheck(evidence, ctx, text, errors, warnings) {
  const resolved = [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push('영상 속 구체적인 말이나 장면을 원문에서 그대로 인용한 근거(evidence)가 하나도 없습니다.');
    return resolved;
  }
  evidence.forEach((ev, i) => {
    const no = i + 1;
    const source = ev?.source;
    const quote = String(ev?.quote ?? '').trim();
    if (!SOURCES.includes(source)) {
      errors.push(`근거 ${no}의 출처 "${source}"는 쓸 수 없습니다. transcript·description·title·comment 중 하나여야 합니다.`);
      return;
    }
    if (normalize(quote).length < MIN_QUOTE_CHARS) {
      errors.push(`근거 ${no}: 인용 “${quote}” — 너무 짧습니다. ${SOURCE_KO[source]}에서 ${MIN_QUOTE_CHARS}글자 이상 이어진 말을 그대로 옮기세요.`);
      return;
    }
    const loc = locateQuote(quote, source, ctx);
    if (!loc.found) {
      // 다른 출처에는 있는지 알려 주면 고치기 쉽다
      const other = SOURCES.find((s) => s !== source && locateQuote(quote, s, ctx).found);
      errors.push(
        other
          ? `근거 ${no}: 인용 “${quote}” — ${SOURCE_KO[source]} 쪽이 아니라 ${SOURCE_KO[other]} 쪽에 있는 말입니다. 출처를 바로잡으세요.`
          : `근거 ${no}: 인용 “${quote}” — ${SOURCE_KO[source]} 원문에서 찾을 수 없습니다. 원문의 말을 고치지 말고 그대로 옮기세요.`,
      );
      return;
    }
    const item = { source, quote, t: source === 'transcript' ? loc.t : null };
    if (source === 'transcript' && ev?.t != null && loc.t != null && Number(ev.t) !== loc.t) item.claimedT = Number(ev.t);
    resolved.push(item);
  });

  // 영상 속 말: 자막이 있으면 자막에서, 없으면 제목·설명에서 하나 이상
  const hasTranscript = ctx?.transcript?.status === 'ok' && (ctx.transcript.segments?.length || ctx.transcript.text);
  const needed = hasTranscript ? ['transcript'] : ['title', 'description'];
  if (resolved.length && !resolved.some((r) => needed.includes(r.source))) {
    errors.push(
      hasTranscript
        ? '자막이 있는 영상인데 자막에서 고른 인용이 없습니다. 영상 속에서 실제로 나온 말을 하나 이상 짚으세요.'
        : '자막이 없는 영상이라 제목이나 설명에서 고른 인용이 하나 이상 있어야 합니다.',
    );
  }

  // 참고: 댓글 본문이 인용과 한 글자 쌍도 겹치지 않으면 인용을 실제로 짚었는지 의심스럽다(막지는 않음)
  const nt = normalize(text);
  const touches = resolved.some((r) => {
    const nq = normalize(r.quote);
    for (let k = 0; k + 2 <= nq.length; k++) if (nt.includes(nq.slice(k, k + 2))) return true;
    return false;
  });
  if (resolved.length && !touches) warnings.push('댓글 본문에 인용한 말과 겹치는 표현이 보이지 않습니다. 영상 속 말을 댓글에서 실제로 짚었는지 확인하세요.');
  return resolved;
}

// 광고 표시 — config.comment.adLabel (true: 맨 앞 "[광고]" 필수 · false: 광고 표시 금지 · 없음: 검사 안 함)
export const AD_LABEL = '[광고]';
const AD_MARK_RE = /[\[(（【<]\s*(?:유료\s*)?(?:광고|협찬|스폰서|AD|PR)\s*[\])）】>]|^\s*(?:광고|협찬)\s*[:：|·]/iu;

export function validateComment(text, ctx, { brand, minChars = 40, maxChars = 120, evidence, adLabel } = {}) {
  const errors = [];
  const warnings = [];
  const raw = typeof text === 'string' ? text : '';
  const t = raw.trim();
  if (!t) return { ok: false, errors: ['댓글이 비어 있습니다.'], warnings, length: { withSpaces: 0, withoutSpaces: 0, min: minChars, max: maxChars }, evidence: [] };

  const length = lengthCheck(t, minChars, maxChars, errors);

  if (/[\r\n\p{Zl}\p{Zp}]/u.test(t)) errors.push('댓글에 줄바꿈이 있습니다. 한 줄로 이어 쓰세요.');

  for (const { re, why } of LINK_PATTERNS) {
    const m = t.match(re);
    if (m) {
      errors.push(`링크는 금지입니다 — ${why}: "${m[0].trim()}"`);
      break;
    }
  }

  const hash = t.match(/[#＃]\S*/u);
  if (hash) errors.push(`해시태그(#)는 금지입니다: "${hash[0]}"`);

  if (brand && !normalize(t).includes(normalize(brand))) errors.push(`댓글에 브랜드 이름 “${brand}”이(가) 없습니다. 이름을 그대로 한 번 넣으세요.`);

  if (adLabel === true && !t.startsWith(AD_LABEL)) errors.push(`광고 표시 설정이 켜져 있습니다. 댓글 맨 앞에 “${AD_LABEL}”를 붙이세요.`);
  if (adLabel === false) {
    const ad = t.match(AD_MARK_RE);
    if (ad) errors.push(`광고 표시 설정이 꺼져 있습니다. “${ad[0].trim()}” 같은 광고 표시를 빼고 시청자 말투로만 쓰세요.`);
  }

  for (const re of FAKE_REVIEW_PATTERNS) {
    const m = t.match(re);
    if (m) {
      errors.push(`직접 이용해 본 것처럼 쓴 체험담 표현이 있습니다: “${m[0].trim()}”. 지어낸 후기는 금지입니다 — 들은 말("~잘 본다던데")이나 바람("~보고 싶다")으로 바꾸세요.`);
      break;
    }
  }

  const resolved = evidence === undefined ? [] : evidenceCheck(evidence, ctx, t, errors, warnings);

  return { ok: errors.length === 0, errors, warnings, length, evidence: resolved };
}
