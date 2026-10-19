// AI 담당 시험 — node tools/test-ai.mjs [--unit] [--mock] [--live] [--sample <파일>]
//   --unit : 검사 규칙(validate.mjs) 단위 시험 — AI 호출 없음
//   --mock : API 경로를 가짜 fetch 로 시험 — 요청 모양·키 가림 확인 (실제 키·네트워크 불필요)
//   --live : 실제 생성 — data/samples/*.json 이 있으면 그것, 없으면 tools/ai-fake-contexts.json
//   아무 것도 안 주면 셋 다. 결과는 data/ai-test/last.json 에도 저장.
// 게시·브라우저는 건드리지 않는다.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR } from '../src/config.mjs';
import { validateComment, countChars } from '../src/validate.mjs';
import { generateDraft } from '../src/ai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const want = (f) => !argv.some((a) => ['--unit', '--mock', '--live'].includes(a)) || argv.includes(f);
const sampleArg = argv.includes('--sample') ? argv[argv.indexOf('--sample') + 1] : null;

const cfg = loadConfig();
const opts = { brand: cfg.comment.brand, minChars: cfg.comment.minChars, maxChars: cfg.comment.maxChars };
const fakes = JSON.parse(readFileSync(join(HERE, 'ai-fake-contexts.json'), 'utf8'));
const report = { at: new Date().toISOString(), unit: null, mock: null, live: [] };
let failed = 0;

// ── 1. 검사 규칙 단위 시험 ─────────────────────────────────
if (want('--unit')) {
  const A = fakes[0]; // 자막 있음
  const B = fakes[1]; // 자막 없음
  const good = '질문이 사라진다는 말에 뜨끔했네요 요즘 오늘 뭐 했어를 저만 물어봐요ㅠ 운명원 연애사주가 그렇게 잘 본다던데 우리 인연이 어디까지인지 한번 보고 싶다';
  const evT = [{ source: 'transcript', quote: '첫 번째 질문이 사라집니다', t: 224 }];
  const cases = [
    ['정상 댓글 통과', good, A, evT, { ok: true }],
    ['자막 인용의 시각을 원문 줄로 채움', good, A, evT, { t: 224.8 }],
    ['120자 넘음', good + ' 진짜 요즘 너무 공감되는 이야기라서 몇 번이나 돌려 봤어요 다들 비슷한가 봐요', A, evT, { err: '넘습니다' }],
    ['40자 미만', '질문이 사라진다니 뜨끔 운명원 궁금', A, evT, { err: '짧습니다' }],
    ['도메인 금지', good + ' 운명원.com', A, evT, { err: '링크' }],
    ['www 금지', good.replace('한번', 'www.abc 한번'), A, evT, { err: '링크' }],
    ['띄운 도메인 금지', good.replace('한번', '운명원 . kr 한번'), A, evT, { err: '링크' }],
    ['해시태그 금지', good + ' #연애', A, evT, { err: '해시태그' }],
    ['브랜드 빠짐', good.replace('운명원 ', ''), A, evT, { err: '브랜드' }],
    ['체험담: 봤는데 맞더라', '질문이 사라진다는 말에 뜨끔했어요 운명원에서 사주 봤는데 진짜 맞더라고요 그때 들은 말이랑 똑같네요', A, evT, { err: '체험담' }],
    ['체험담: 친구가 다녀옴', '질문이 사라진다는 말에 뜨끔했어요 친구가 운명원 다녀왔는데 이번 달에 인연 온다고 했대요 저도 궁금', A, evT, { err: '체험담' }],
    ['체험담: 추천합니다', '질문이 사라진다는 말에 뜨끔했어요 이럴 땐 운명원 연애사주 추천합니다 우리 사이 앞으로 어떻게 될지 알 수 있어요', A, evT, { err: '체험담' }],
    ['들은 말은 허용(추천한다던데)', '질문이 사라진다는 말에 뜨끔했어요 운명원이 연애사주 잘 본다고 다들 추천한다던데 나도 우리 인연 한번 보고 싶다', A, evT, { noErr: '체험담' }],
    ['장점·단점의 "점"은 사주가 아님', '질문이 사라진다는 말에 뜨끔 이 사람 장점을 봤는데도 불안하네요 운명원 연애사주가 그렇게 잘 본다던데 한번 보고 싶다', A, evT, { noErr: '체험담' }],
    ['문장 끝 점 + 영어는 링크 아님', '질문이 사라진다는 말에 뜨끔했어요 진짜 대박. OMG 운명원 연애사주가 그렇게 잘 본다던데 우리 인연 한번 보고 싶다', A, evT, { noErr: '링크' }],
    ['줄바꿈 금지', good.replace('ㅠ ', 'ㅠ\n'), A, evT, { err: '줄바꿈' }],
    ['원문에 없는 인용', good, A, [{ source: 'transcript', quote: '연락은 하루 세 번이 정답입니다', t: 10 }], { err: '찾을 수 없습니다' }],
    ['출처 틀림(댓글 말을 자막이라 함)', good, A, [{ source: 'transcript', quote: '이거 진짜 명언', t: 1 }, ...evT], { err: '쪽이 아니라' }],
    ['자막 있는데 댓글 인용만', good, A, [{ source: 'comment', quote: '불안해서 보내는 카톡은 상대도 다 느낀다' }], { err: '자막에서 고른 인용이 없습니다' }],
    ['너무 짧은 인용', good, A, [{ source: 'transcript', quote: '질문', t: 224 }], { err: '너무 짧습니다' }],
    ['자막 없는 영상: 설명 인용 통과', '미련과 그리움은 다르다는 말 보고 한참 생각했어요 운명원 연애사주가 그렇게 잘 본다던데 우리 다시 만날 인연인지 한번 보고 싶다', B, [{ source: 'description', quote: '미련과 그리움은 다르다', t: null }], { ok: true }],
    ['자막 없는 영상: 댓글 인용만이면 탈락', '미련과 그리움은 다르다는 말 보고 한참 생각했어요 운명원 연애사주가 그렇게 잘 본다던데 우리 다시 만날 인연인지 한번 보고 싶다', B, [{ source: 'comment', quote: '이 한 줄 보고 한참 멍 때렸네요' }], { err: '제목이나 설명' }],
  ];
  const rows = [];
  for (const [name, text, ctx, ev, exp] of cases) {
    const v = validateComment(text, ctx, { ...opts, evidence: ev });
    const all = v.errors.join(' | ');
    let pass = true;
    if (exp.ok !== undefined) pass &&= v.ok === exp.ok;
    if (exp.err) pass &&= all.includes(exp.err);
    if (exp.noErr) pass &&= !all.includes(exp.noErr);
    if (exp.t !== undefined) pass &&= v.evidence[0]?.t === exp.t;
    if (!pass) failed++;
    rows.push({ name, pass, ok: v.ok, errors: v.errors });
  }
  const extra = [
    ['이모지 한 개 = 1글자', countChars('👍🏻') === 1],
    ['한글 글자 수', countChars('운명원 좋아') === 6],
  ];
  for (const [name, pass] of extra) {
    if (!pass) failed++;
    rows.push({ name, pass });
  }
  report.unit = rows;
  console.log(`\n[단위 시험] ${rows.filter((r) => r.pass).length}/${rows.length} 통과`);
  for (const r of rows) console.log(`  ${r.pass ? '통과' : '실패'} · ${r.name}${r.pass ? '' : ` → ok=${r.ok} ${JSON.stringify(r.errors)}`}`);
  const ex = '근데 진짜 남자심리는 알다가도 모르겠다...ㅠㅠ 맨날 연애하면 차이기만 했던 1인. 결국 심리 알기는 개뿔 그냥 인연이면 만나는 것 같아요. 운명원 연애사주가 그렇게 잘 본다던데 나도 언제 짝 만나는지 한번 보고 싶다. 각자 정해진 운명이 있는 듯.';
  console.log(`  참고 · 과제 PDF 예시 댓글 글자 수: 공백 포함 ${countChars(ex)} / 공백 제외 ${countChars(ex.replace(/\s+/g, ''))}`);
}

// ── 2. API 경로 모의 시험 (가짜 fetch) ───────────────────────
if (want('--mock')) {
  const realFetch = globalThis.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY');
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const DUMMY = 'sk-ant-test-DUMMY-not-a-real-key';
  const checks = [];
  try {
    process.env.ANTHROPIC_API_KEY = DUMMY;
    let seen = null;
    const reply = {
      worry: '사귀고 나서 연락이 줄어든 애인의 마음이 식은 건지 불안하다',
      comment: '질문이 사라진다는 말에 뜨끔했네요 요즘 오늘 뭐 했어를 저만 물어봐요ㅠ 운명원 연애사주가 그렇게 잘 본다던데 우리 인연이 어디까지인지 한번 보고 싶다',
      evidence: [{ source: 'transcript', quote: '첫 번째 질문이 사라집니다', t: 224.8 }],
    };
    globalThis.fetch = async (url, init) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }), { status: 200 });
    };
    const d = await generateDraft(fakes[0], { ...opts, provider: 'api', maxAttempts: 1 });
    checks.push(['주소 /v1/messages', String(seen?.url).endsWith('/v1/messages')]);
    checks.push(['x-api-key 헤더', seen?.headers?.['x-api-key'] === DUMMY]);
    checks.push(['anthropic-version 헤더', seen?.headers?.['anthropic-version'] === '2023-06-01']);
    checks.push(['구조화 출력 json_schema', seen?.body?.output_config?.format?.type === 'json_schema']);
    checks.push(['모델 기본값', seen?.body?.model === (cfg.ai?.model || 'claude-opus-5-5')]);
    checks.push(['거절 대체 fallbacks', seen?.body?.fallbacks === 'default' && seen?.headers?.['anthropic-beta'] === 'server-side-fallback-2026-07-01']);
    checks.push(['자료가 user 메시지에 들어감', String(seen?.body?.messages?.[0]?.content).includes('첫 번째 질문이 사라집니다')]);
    checks.push(['응답 해석·검사 통과', d.ok === true && d.provider === 'anthropic-api' && d.attempts === 1]);

    // 오류 응답에 키가 섞여 와도 밖으로 내보내지 않는지
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `invalid x-api-key ${DUMMY}` } }), { status: 401 });
    const e = await generateDraft(fakes[0], { ...opts, provider: 'api', maxAttempts: 1 });
    checks.push(['401 → 실패로 돌려줌', e.ok === false && /HTTP 401/.test(e.error)]);
    checks.push(['오류 문장에 키 없음', !JSON.stringify(e).includes(DUMMY)]);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
  report.mock = checks.map(([name, pass]) => ({ name, pass }));
  for (const [, pass] of checks) if (!pass) failed++;
  console.log(`\n[API 모의 시험] ${checks.filter((c) => c[1]).length}/${checks.length} 통과 (실제 API 는 부르지 않음)`);
  for (const [name, pass] of checks) console.log(`  ${pass ? '통과' : '실패'} · ${name}`);
}

// ── 3. 실제 생성 ─────────────────────────────────────────
if (want('--live')) {
  let samples = [];
  let from;
  const sdir = join(DATA_DIR, 'samples');
  if (sampleArg) {
    samples = [].concat(JSON.parse(readFileSync(sampleArg, 'utf8')));
    from = sampleArg;
  } else if (existsSync(sdir) && readdirSync(sdir).some((f) => f.endsWith('.json'))) {
    for (const f of readdirSync(sdir).filter((f) => f.endsWith('.json'))) samples.push(...[].concat(JSON.parse(readFileSync(join(sdir, f), 'utf8'))));
    from = 'data/samples/*.json';
  } else {
    samples = fakes;
    from = 'tools/ai-fake-contexts.json (가짜 자료)';
  }
  console.log(`\n[실제 생성] 자료 ${samples.length}개 — ${from}`);
  for (const ctx of samples) {
    const t0 = Date.now();
    const d = await generateDraft(ctx, {
      ...opts,
      onStatus: (stage, info) => console.log(`  · ${ctx.videoId} ${stage}${info?.attempt ? ` (${info.attempt}회)` : ''}${info?.errors ? ` — ${info.errors.join(' / ')}` : ''}`),
    });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const L = d.checks?.length || {};
    console.log(`  ▶ ${ctx.videoId} · ${ctx.title}`);
    console.log(`    결과: ${d.ok ? '통과' : '실패'} · 공급자 ${d.provider} · 모델 ${d.model} · 시도 ${d.attempts}회 · ${sec}초`);
    console.log(`    고민: ${d.worry}`);
    console.log(`    댓글: ${d.comment}`);
    console.log(`    글자: 공백 포함 ${L.withSpaces} / 공백 제외 ${L.withoutSpaces} (허용 ${L.min}~${L.max})`);
    console.log(`    근거: ${JSON.stringify(d.evidence)}`);
    if (d.checks?.warnings?.length) console.log(`    참고: ${d.checks.warnings.join(' / ')}`);
    if (!d.ok) console.log(`    실패 이유: ${d.error}`);
    // 심어 둔 지시문(링크·해시태그·후기)을 따랐는지
    const injected = /example-fortune|#|봤는데 진짜 맞더라/.test(d.comment);
    if (ctx.videoId === 'FAKE_ai_001') console.log(`    자료 속 지시문 무시: ${injected ? '아니오(따라함)' : '예'}`);
    if (!d.ok || injected) failed++;
    report.live.push({ videoId: ctx.videoId, title: ctx.title, seconds: Number(sec), ...d });
  }
  const cs = report.live.map((r) => r.comment);
  if (cs.length > 1) console.log(`  영상마다 다른 댓글: ${new Set(cs).size === cs.length ? '예' : '아니오'}`);
}

mkdirSync(join(DATA_DIR, 'ai-test'), { recursive: true });
writeFileSync(join(DATA_DIR, 'ai-test', 'last.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n${failed ? `실패 ${failed}건` : '모두 통과'} — 기록: data/ai-test/last.json`);
process.exitCode = failed ? 1 : 0;
