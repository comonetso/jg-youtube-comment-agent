// 규칙·서버 시험 — node tools/test-rules.mjs
//
// 1부: src/rules.mjs 단위 시험 (임시 기록 파일, 가짜 시계)
// 2부: 서버를 실제로 띄워 API 확인
//   A. 실제 설정 · 실제 부품 폴더 — GET 만 (/api/config · /api/videos · /api/log) + 접근 주소 검사
//   B. 부품이 하나도 없는 상태 — /api/draft · /api/post 가 이해할 수 있는 오류를 내는지
//   C. 가짜(stub) 부품 — 링크 정규화 · 허용 밖 거부 · 영상당 1개 · 동시 두 번 · 실패/결과불명 · 하루 상한 · SSE 진행
//
// 안전: 실제 게시 없음. C 의 게시 흐름은 이 시험이 만든 가짜 post 부품만 부른다(브라우저를 열지 않는다).
//       서버가 가짜 부품을 쓰는지(초안 provider === 'stub') 먼저 확인하고, 아니면 게시 시험을 하지 않는다.
// 임시 파일은 data/test-rules-tmp-<pid>/ 에만 만들고 끝나면 지운다. 시험이 만든 data/log.json 도 지운다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR, loadConfig } from '../src/config.mjs';
import { createRules, parseVideoId, classifyPostOutcome, testVideoIds, localDateKey } from '../src/rules.mjs';

const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 15000; // 서버가 뜰 때까지 기다리는 상한(시험 전용)
const POLL_MS = 100; // 서버 준비 확인 간격(시험 전용)

const LOG_JSON = join(DATA_DIR, 'log.json');
const dataExisted = existsSync(DATA_DIR);
const logExisted = existsSync(LOG_JSON);
const TMP = join(DATA_DIR, `test-rules-tmp-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════
// 1부 — 규칙 단위 시험
// ════════════════════════════════════════════════════════════════════
const CH_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CH_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CH_X = 'UCxxxxxxxxxxxxxxxxxxxxxx';
const PROFILE = { id: 'youtube1', name: '유튜브1' };
const TEXT = '영상에서 연락 빈도가 마음의 크기는 아니라던 말이 계속 생각나요. 운명원 연애사주로 우리 인연이 언제쯤인지 한번 보고 싶다.';
let clock = new Date(2026, 9, 19, 10, 0, 0); // 로컬 2026-10-19 10:00
const now = () => new Date(clock.getTime());
let unitSeq = 0;
function makeRules(cfgOverride = {}, logName) {
  const cfg = {
    channels: [
      { id: CH_A, name: '허용채널A' },
      { id: CH_B, name: '허용채널B' },
    ],
    testVideos: ['https://youtu.be/TESTVID0001'],
    limits: { dailyMaxComments: 3 },
    ...cfgOverride,
  };
  const logPath = join(TMP, logName || `unit-${++unitSeq}.json`);
  return { rules: createRules({ getConfig: () => cfg, logPath, now }), logPath, cfg };
}
const meta = (videoId, channelId = CH_A, extra = {}) => ({ videoId, title: `제목 ${videoId}`, channelId, channelName: channelId === CH_X ? '남의채널' : '허용채널A', ...extra });

console.log('\n1부 — 규칙 단위 시험 (src/rules.mjs)');

await test('링크 정규화: youtu.be · watch?v= · shorts/ · 그냥 ID · 잘못된 입력', () => {
  const id = 'akn-AvCeHBI';
  for (const s of [
    id,
    `youtu.be/${id}`,
    `https://youtu.be/${id}?si=abcdef`,
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?app=desktop&v=${id}&t=42s`,
    `m.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}?feature=share`,
    `https://www.youtube.com/live/${id}`,
    `  https://www.youtube.com/embed/${id}  `,
  ]) {
    assert.equal(parseVideoId(s), id, `"${s}" → ${id} 이어야 함`);
  }
  for (const s of ['', '   ', 'hello', 'akn-AvCeHB', `https://example.com/watch?v=${id}`, `https://evilyoutube.com/watch?v=${id}`, `https://youtube.com.evil.io/watch?v=${id}`, 'https://www.youtube.com/@channel', 'javascript:alert(1)', null, 123]) {
    assert.equal(parseVideoId(s), null, `"${s}" 는 null 이어야 함`);
  }
});

await test('testVideos 는 ID·링크·객체 모두 받는다', () => {
  const ids = testVideoIds({ testVideos: ['TESTVID0001', 'https://youtu.be/TESTVID0002', { videoId: 'TESTVID0003' }, { url: 'youtube.com/shorts/TESTVID0004' }, 'bad'] });
  assert.deepEqual([...ids].sort(), ['TESTVID0001', 'TESTVID0002', 'TESTVID0003', 'TESTVID0004']);
});

await test('허용 범위: 지정 채널 OK · 남의 채널 거부(이유에 채널 이름) · 채널 모름 거부 · 테스트 영상은 채널 무관 OK', () => {
  const { rules } = makeRules();
  assert.equal(rules.checkAllowed(meta('VIDEO000001', CH_A)).ok, true);
  assert.equal(rules.checkAllowed(meta('VIDEO000001', CH_B)).ok, true);
  const x = rules.checkAllowed(meta('VIDEO000002', CH_X));
  assert.equal(x.ok, false);
  assert.equal(x.code, 'NOT_ALLOWED');
  assert.match(x.reason, /허용된 채널의 영상이 아닙니다/);
  assert.match(x.reason, /남의채널/);
  assert.equal(rules.checkAllowed({ videoId: 'VIDEO000003' }).ok, false);
  const t = rules.checkAllowed(meta('TESTVID0001', CH_X));
  assert.equal(t.ok, true);
  assert.equal(t.via, 'testVideo');
});

await test('허용 밖 영상은 예약이 거부되고 기록도 남지 않는다', () => {
  const { rules, logPath } = makeRules();
  const r = rules.reserve({ meta: meta('VIDEO000002', CH_X), profile: PROFILE, text: TEXT, dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_ALLOWED');
  const r2 = rules.reserve({ meta: meta('VIDEO000002', CH_X), profile: PROFILE, text: TEXT, dryRun: true });
  assert.equal(r2.ok, false, '연습도 허용 범위 밖이면 거부');
  assert.equal(rules.entries().length, 0);
  assert.equal(existsSync(logPath), false);
});

await test('같은 영상 두 번째는 거부 (성공 뒤)', () => {
  const { rules } = makeRules();
  const r = rules.reserve({ meta: meta('VIDEO000001'), profile: PROFILE, text: TEXT, dryRun: false });
  assert.equal(r.ok, true);
  rules.finish(r.reservation, { result: 'success', reason: '확인됨' });
  const r2 = rules.reserve({ meta: meta('VIDEO000001'), profile: { id: 'youtube2', name: '유튜브2' }, text: TEXT, dryRun: false });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'ALREADY_COMMENTED', '다른 프로필이어도 영상당 1개');
  assert.ok(rules.lockOf('VIDEO000001'));
});

await test('결과불명도 잠근다', () => {
  const { rules } = makeRules();
  const r = rules.reserve({ meta: meta('VIDEO000004'), profile: PROFILE, text: TEXT, dryRun: false });
  rules.finish(r.reservation, { result: 'unknown', reason: '확인 못 함' });
  const r2 = rules.reserve({ meta: meta('VIDEO000004'), profile: PROFILE, text: TEXT, dryRun: false });
  assert.equal(r2.code, 'ALREADY_COMMENTED');
});

await test('확실한 실패는 잠금을 푼다 (다시 예약 가능)', () => {
  const { rules } = makeRules();
  const r = rules.reserve({ meta: meta('VIDEO000005'), profile: PROFILE, text: TEXT, dryRun: false });
  rules.finish(r.reservation, { result: 'failed', reason: '댓글 창 못 찾음' });
  assert.equal(rules.lockOf('VIDEO000005'), null);
  const r2 = rules.reserve({ meta: meta('VIDEO000005'), profile: PROFILE, text: TEXT, dryRun: false });
  assert.equal(r2.ok, true);
});

await test('연습은 기록되지만 잠금·상한에 넣지 않는다', () => {
  const { rules } = makeRules({ limits: { dailyMaxComments: 1 } });
  const p = rules.reserve({ meta: meta('VIDEO000006'), profile: PROFILE, text: TEXT, dryRun: true });
  assert.equal(p.ok, true);
  const e = rules.finish(p.reservation, { result: 'success' }); // 연습 예약은 무엇을 넘겨도 practice
  assert.equal(e.result, 'practice');
  assert.equal(rules.lockOf('VIDEO000006'), null);
  assert.equal(rules.todayStatus().count, 0);
  const r = rules.reserve({ meta: meta('VIDEO000006'), profile: PROFILE, text: TEXT, dryRun: false });
  assert.equal(r.ok, true, '연습 뒤 실제 게시 가능');
  rules.finish(r.reservation, { result: 'success' });
  assert.equal(rules.todayStatus().count, 1);
  const p2 = rules.reserve({ meta: meta('VIDEO000007'), profile: PROFILE, text: TEXT, dryRun: true });
  assert.equal(p2.ok, true, '상한에 닿아도 연습은 된다');
  rules.finish(p2.reservation, {});
  assert.equal(rules.entries().length, 3);
});

await test('dryRun 을 빼먹으면 연습으로 다룬다 (명시적 false 만 실제 게시)', () => {
  const { rules } = makeRules();
  const r = rules.reserve({ meta: meta('VIDEO000008'), profile: PROFILE, text: TEXT });
  assert.equal(r.ok, true);
  assert.equal(r.entry.dryRun, true);
});

await test('동시 예약: 같은 영상을 동시에 두 번 → 하나만 통과, 진행 중엔 연습도 거부', async () => {
  const { rules } = makeRules();
  const go = async (dryRun) => rules.reserve({ meta: meta('VIDEO000009'), profile: PROFILE, text: TEXT, dryRun });
  const rs = await Promise.all([go(false), go(false), go(false)]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.deepEqual(rs.filter((r) => !r.ok).map((r) => r.code), ['IN_PROGRESS', 'IN_PROGRESS']);
  const p = await go(true);
  assert.equal(p.code, 'IN_PROGRESS');
  assert.equal(rules.todayStatus().count, 1, '진행 중 예약도 상한에 센다');
});

await test('하루 상한: 성공·결과불명을 세고 실패는 안 센다 · 상한이면 거부 · 날짜 바뀌면 다시 됨', () => {
  const { rules } = makeRules({ limits: { dailyMaxComments: 3 } });
  const post = (id, result) => {
    const r = rules.reserve({ meta: meta(id), profile: PROFILE, text: TEXT, dryRun: false });
    if (!r.ok) return r;
    rules.finish(r.reservation, { result });
    return r;
  };
  assert.equal(post('CAP00000001', 'success').ok, true);
  assert.equal(post('CAP00000002', 'failed').ok, true);
  assert.equal(post('CAP00000003', 'unknown').ok, true);
  assert.equal(rules.todayStatus().count, 2);
  assert.equal(post('CAP00000004', 'success').ok, true);
  assert.equal(rules.todayStatus().count, 3);
  const over = rules.reserve({ meta: meta('CAP00000005'), profile: PROFILE, text: TEXT, dryRun: false });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'DAILY_LIMIT');
  assert.match(over.reason, /3개/);
  clock = new Date(2026, 9, 20, 0, 0, 5); // 다음날 00:00:05 (로컬)
  assert.equal(rules.todayStatus().count, 0);
  assert.equal(rules.todayStatus().date, '2026-10-20');
  assert.equal(post('CAP00000005', 'success').ok, true);
  clock = new Date(2026, 9, 19, 10, 0, 0);
});

await test('설정에 상한이 없으면 과제 기본값 10', () => {
  const { rules } = makeRules({ limits: {} });
  assert.equal(rules.todayStatus().max, 10);
});

await test('기록 파일: 시간순 배열 · 시각·영상·제목·채널·프로필·댓글·결과·이유가 있다', () => {
  const { rules, logPath } = makeRules();
  const a = rules.reserve({ meta: meta('LOG00000001'), profile: PROFILE, text: TEXT, dryRun: false });
  rules.finish(a.reservation, { result: 'success', reason: '확인됨' });
  clock = new Date(clock.getTime() + 60000);
  const b = rules.reserve({ meta: meta('LOG00000002'), profile: PROFILE, text: TEXT, dryRun: true });
  rules.finish(b.reservation, {});
  clock = new Date(2026, 9, 19, 10, 0, 0);
  const file = JSON.parse(readFileSync(logPath, 'utf8'));
  assert.ok(Array.isArray(file));
  assert.equal(file.length, 2);
  assert.ok(file[0].time <= file[1].time, '시간순');
  for (const k of ['time', 'date', 'videoId', 'title', 'channelId', 'channelName', 'profileId', 'profileName', 'comment', 'result', 'resultLabel', 'reason', 'dryRun']) {
    assert.ok(k in file[0], `필드 ${k}`);
  }
  assert.equal(file[0].resultLabel, '성공');
  assert.equal(file[1].resultLabel, '연습');
  assert.equal(file[0].comment, TEXT);
  assert.equal(file[0].date, localDateKey(new Date(file[0].time)));
});

await test('다시 시작해도 잠금 유지 · 게시 도중 꺼진 흔적(진행 중)은 결과불명으로 확정되어 잠근다', () => {
  const name = 'restart.json';
  const first = makeRules({}, name);
  const r = first.rules.reserve({ meta: meta('RST00000001'), profile: PROFILE, text: TEXT, dryRun: false });
  first.rules.finish(r.reservation, { result: 'success' });
  first.rules.reserve({ meta: meta('RST00000002'), profile: PROFILE, text: TEXT, dryRun: false }); // 끝내지 않음 = 앱이 꺼진 상황
  const second = makeRules({}, name);
  assert.equal(second.rules.reserve({ meta: meta('RST00000001'), profile: PROFILE, text: TEXT, dryRun: false }).code, 'ALREADY_COMMENTED');
  const e = second.rules.entries().find((x) => x.videoId === 'RST00000002');
  assert.equal(e.result, 'unknown');
  assert.match(e.reason, /꺼져/);
  assert.equal(second.rules.reserve({ meta: meta('RST00000002'), profile: PROFILE, text: TEXT, dryRun: false }).code, 'ALREADY_COMMENTED');
});

await test('기록 파일이 깨져 있으면 시작하지 않는다(잠금을 잃지 않으려고)', () => {
  const p = join(TMP, 'broken.json');
  writeFileSync(p, '{ 깨진', 'utf8');
  assert.throws(() => createRules({ getConfig: () => ({ channels: [] }), logPath: p }), /읽을 수 없어/);
});

await test('게시 결과 가르기: 확인됨=성공 · 게시 전 실패=실패 · 게시 후 실패=결과불명 · 연습=연습', () => {
  const c = (o) => classifyPostOutcome(o).result;
  assert.equal(c({ dryRun: false, result: { ok: true, verified: true } }), 'success');
  assert.equal(c({ dryRun: false, result: { ok: true, verified: false } }), 'unknown');
  assert.equal(c({ dryRun: false, error: new Error('x'), seenStages: ['opening', 'loading'] }), 'failed');
  assert.equal(c({ dryRun: false, error: new Error('x'), seenStages: ['opening', 'loading', 'typing'] }), 'failed');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'typing', error: 'x' }, seenStages: [] }), 'failed');
  assert.equal(c({ dryRun: false, error: new Error('x'), seenStages: ['opening', 'typing', 'posting'] }), 'unknown');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'verifying' }, seenStages: ['typing'] }), 'unknown');
  assert.equal(c({ dryRun: false, error: new Error('조종 통로 연결 실패') }), 'failed');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'failed' } }), 'unknown', '단계를 모르면 보수적으로 결과불명');
  assert.equal(c({ dryRun: true, result: { ok: true } }), 'practice');
  assert.equal(c({ dryRun: true, error: new Error('x') }), 'practice');
});

await test('게시 부품(post.mjs)의 신호 반영: submitted·outcome', () => {
  const c = (o) => classifyPostOutcome(o).result;
  // post.mjs 모양: { ok, stage, verified, outcome: 'dry-run'|'posted'|'unknown'|'failed', submitted }
  assert.equal(c({ dryRun: false, result: { ok: true, verified: true, outcome: 'posted', submitted: true } }), 'success');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'verifying', outcome: 'unknown', submitted: true, error: '결과 불명' } }), 'unknown');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'posting', outcome: 'unknown', submitted: true } }), 'unknown', '제출 뒤 예외');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'posting', outcome: 'failed', submitted: false, error: '제출 버튼이 켜지지 않았습니다' } }), 'failed', '제출 전 실패는 확실한 실패');
  assert.equal(c({ dryRun: false, result: { ok: false, stage: 'loading', outcome: 'failed', submitted: false, error: '로그인 안 됨' } }), 'failed');
  assert.equal(c({ dryRun: true, result: { ok: true, outcome: 'dry-run', submitted: false } }), 'practice');
});

// ════════════════════════════════════════════════════════════════════
// 2부 — 서버를 실제로 띄워 확인
// ════════════════════════════════════════════════════════════════════
function startServer(env = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const ready = (async () => {
    const end = Date.now() + SERVER_READY_TIMEOUT_MS;
    let gone = false;
    exited.then(() => (gone = true));
    while (Date.now() < end && !gone) {
      try {
        const r = await fetch(`${BASE}/api/config`);
        if (r.ok) return;
      } catch {}
      await sleep(POLL_MS);
    }
    throw new Error(`서버가 뜨지 않았습니다:\n${out.join('')}`);
  })();
  return { child, out, exited, ready };
}
async function stopServer(s) {
  if (s.child.exitCode === null) s.child.kill();
  await s.exited;
}

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
}

/** SSE 받아 두기 */
function listenEvents() {
  const ac = new AbortController();
  const events = [];
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {}
  })();
  return { events, stop: async () => { ac.abort(); await done; } };
}

const realCfg = loadConfig();

// ── A. 실제 설정 · 실제 부품 폴더 (GET 만) ─────────────────────────
console.log('\n2부 A — 서버를 실제로 띄움 (실제 설정 · GET 만)');
{
  const s = startServer();
  try {
    await s.ready;
    await test('127.0.0.1:4310 에 뜬다 (시작 문구)', () => {
      assert.match(s.out.join(''), /http:\/\/127\.0\.0\.1:4310/);
    });
    await test('GET /api/config — 채널 5·프로필·글자 수·상한·부품 상태, 비밀값 없음', async () => {
      const { status, data } = await call('GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.channels.length, realCfg.channels.length);
      assert.ok(data.profiles.length >= 1);
      assert.equal(data.limits.dailyMaxComments, realCfg.limits.dailyMaxComments);
      assert.equal(data.comment.minChars, realCfg.comment.minChars);
      assert.ok(data.modules && 'collect' in data.modules && 'post' in data.modules);
      assert.ok(data.today && typeof data.today.count === 'number');
      assert.doesNotMatch(JSON.stringify(data), /api[_-]?key|token|secret|cdpPort|userDataDir/i);
    });
    await test('GET /api/videos — 지정 채널 영상이 썸네일·제목·채널·올린 날짜와 함께 온다', async () => {
      const { status, data } = await call('GET', '/api/videos');
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.ok(data.videos.length > 0, `영상 0개 (errors: ${JSON.stringify(data.errors)})`);
      const ids = new Set(realCfg.channels.map((c) => c.id));
      for (const v of data.videos) {
        assert.ok(v.videoId && v.title && v.channelName && v.publishedAt && v.thumbnail, `필드 빠짐: ${JSON.stringify(v)}`);
        assert.ok(ids.has(v.channelId), `허용 채널 밖 영상이 목록에 있음: ${v.channelId}`);
      }
      assert.ok(Array.isArray(data.testVideos));
      for (const item of realCfg.testVideos || []) {
        if (!item || typeof item !== 'object' || !item.title) continue;
        const card = data.testVideos.find((v) => v.videoId === item.videoId);
        assert.ok(card, `테스트 영상 카드 없음: ${item.videoId}`);
        assert.equal(card.title, item.title, '테스트 영상 카드는 config 의 제목을 쓴다');
        assert.equal(card.isTest, true);
      }
      console.log(`      (영상 ${data.videos.length}개 · 채널 오류 ${data.errors.length}개 · 테스트 영상 ${data.testVideos.length}개)`);
    });
    await test('GET /api/log — 배열과 오늘 상태', async () => {
      const { status, data } = await call('GET', '/api/log');
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.entries));
      assert.ok(data.today && data.today.max === realCfg.limits.dailyMaxComments);
    });
    await test('화면 파일(/, /app.js, /style.css)이 나온다', async () => {
      for (const p of ['/', '/app.js', '/style.css']) {
        const r = await fetch(`${BASE}${p}`);
        assert.equal(r.status, 200, p);
        await r.text();
      }
    });
    await test('다른 주소(Host)로 오면 403 · 다른 사이트(Origin) POST 는 403 · JSON 아닌 POST 는 415', async () => {
      assert.equal(await rawGet('/api/config', { Host: 'evil.example:4310' }), 403);
      const o = await call('POST', '/api/draft', { body: { videoId: 'akn-AvCeHBI' }, headers: { Origin: 'https://evil.example' } });
      assert.equal(o.status, 403);
      assert.equal(o.data.code, 'BAD_ORIGIN');
      const t = await call('POST', '/api/post', { body: '{"videoId":"akn-AvCeHBI"}', headers: { 'Content-Type': 'text/plain' } });
      assert.equal(t.status, 415);
    });
    await test('127.0.0.1 에만 열린다 (이 PC 의 다른 주소로는 연결 안 됨)', async () => {
      const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
      if (!lan) {
        console.log('      (다른 IPv4 주소가 없어 건너뜀)');
        return;
      }
      const err = await new Promise((resolve) => {
        const r = http.get({ host: lan.address, port: PORT, path: '/api/config', timeout: 3000 }, (res) => {
          res.resume();
          resolve(null);
        });
        r.on('timeout', () => {
          r.destroy(new Error('timeout'));
        });
        r.on('error', (e) => resolve(e));
      });
      assert.ok(err, `${lan.address}:${PORT} 로 연결됨 — 바깥에 열려 있음`);
    });
  } finally {
    await stopServer(s);
  }
}

// ── B. 부품이 하나도 없는 상태 ───────────────────────────────────────
console.log('\n2부 B — 다른 담당 부품이 없을 때 (빈 부품 폴더)');
{
  const emptyDir = join(TMP, 'empty-modules');
  mkdirSync(emptyDir, { recursive: true });
  const logB = join(TMP, 'server-b-log.json');
  const s = startServer({ JG_MODULES_DIR: emptyDir, JG_LOG_PATH: logB });
  try {
    await s.ready;
    let feedId = null;
    await test('GET /api/config 의 부품 상태가 모두 없음', async () => {
      const { data } = await call('GET', '/api/config');
      assert.deepEqual(data.modules, { collect: false, ai: false, validate: false, post: false });
    });
    await test('목록 영상으로 /api/draft → 503 · 무엇이 없는지 말해 준다', async () => {
      const v = await call('GET', '/api/videos');
      feedId = v.data.videos[0]?.videoId;
      assert.ok(feedId, '목록 영상 없음');
      const { status, data } = await call('POST', '/api/draft', { body: { videoId: feedId } });
      assert.equal(status, 503);
      assert.equal(data.code, 'MODULE_MISSING');
      assert.match(data.error, /부품\(src\/\w+\.mjs\)이 아직 준비되지 않아/);
      console.log(`      → "${data.error}"`);
    });
    await test('모르는 링크로 /api/draft → 503 · 채널을 확인할 부품(collect)이 없다고', async () => {
      const { status, data } = await call('POST', '/api/draft', { body: { url: 'https://youtu.be/AAAAAAAAAAA' } });
      assert.equal(status, 503);
      assert.match(data.error, /collect\.mjs/);
    });
    await test('알아볼 수 없는 링크 → 400 · 예시를 보여 준다', async () => {
      const { status, data } = await call('POST', '/api/draft', { body: { url: '그냥 글자' } });
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_INPUT');
      assert.match(data.error, /youtu\.be/);
    });
    await test('/api/post → 503 · 게시 부품(post)이 없다고 · 기록은 남지 않는다', async () => {
      const { status, data } = await call('POST', '/api/post', { body: { videoId: feedId, text: TEXT, profileId: realCfg.profiles[0].id, dryRun: true } });
      assert.equal(status, 503);
      assert.match(data.error, /post\.mjs/);
      console.log(`      → "${data.error}"`);
      const log = await call('GET', '/api/log');
      assert.equal(log.data.entries.length, 0);
      assert.equal(existsSync(logB), false);
    });
  } finally {
    await stopServer(s);
  }
}

// ── C. 가짜 부품으로 게시 흐름 ───────────────────────────────────────
console.log('\n2부 C — 가짜(stub) 부품으로 규칙을 서버에서 확인');
{
  const stubDir = join(TMP, 'stub-modules');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'collect.mjs'),
    `// 시험용 가짜 수집 부품 — 브라우저를 열지 않는다
const ALLOWED = process.env.STUB_ALLOWED_CHANNEL;
export async function getVideoMeta(videoId) {
  if (videoId.startsWith('X')) return { videoId, title: '남의 채널 영상', channelId: 'UCforeignforeignforeign0', channelName: '남의채널', description: '', publishedAt: null, isLive: false };
  return { videoId, title: '시험 영상 ' + videoId, channelId: ALLOWED, channelName: '시험 채널', description: '설명', publishedAt: '2026-10-18T00:00:00+00:00', isLive: false };
}
export async function collectVideoContext(videoId, { onStatus } = {}) {
  onStatus?.('transcript', '자막 읽는 중(가짜)');
  const m = await getVideoMeta(videoId);
  return { ...m, transcript: { status: 'ok', lang: 'ko', text: '가짜 자막', segments: [{ t: 12, text: '가짜 자막' }] }, topComments: [{ author: 'a', text: 'b', likes: 1 }], collectedAt: new Date().toISOString() };
}
`,
  );
  writeFileSync(
    join(stubDir, 'ai.mjs'),
    `// 시험용 가짜 AI 부품
export async function generateDraft(ctx) {
  return { worry: '가짜 고민 한 줄', comment: ${JSON.stringify(TEXT)}, evidence: [{ source: 'transcript', quote: '가짜 자막', t: 12 }], provider: 'stub', attempts: 1, checks: [] };
}
`,
  );
  writeFileSync(
    join(stubDir, 'post.mjs'),
    `// 시험용 가짜 게시 부품 — 브라우저를 열지 않고 단계만 알린다
const calls = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function postComment({ videoId, text, dryRun = true, onStatus }) {
  const n = (calls.get(videoId) || 0) + 1;
  calls.set(videoId, n);
  onStatus?.('opening');
  onStatus?.('loading');
  const total = Array.from(text).length;
  for (let i = 10; i < total; i += 10) onStatus?.('typing', { typed: i, total });
  onStatus?.('typing', { typed: total, total });
  if (videoId.startsWith('SLOW')) await sleep(300);
  if (videoId.startsWith('FAILPRE') && n === 1) throw new Error('댓글 창을 찾지 못함(가짜)');
  if (dryRun) { onStatus?.('done', { outcome: 'dry-run' }); return { ok: true, stage: 'done', dryRun: true, verified: false, commentText: text, authorName: 'STUB', screenshot: null, error: null, outcome: 'dry-run', submitted: false }; }
  onStatus?.('posting', { step: 'wait-submit' });
  if (videoId.startsWith('NOSUBMIT') && n === 1) {
    onStatus?.('failed', { stage: 'posting', error: '제출 버튼이 켜지지 않았습니다(가짜)', outcome: 'failed' });
    return { ok: false, stage: 'posting', dryRun: false, verified: false, commentText: text, authorName: 'STUB', screenshot: null, error: '제출 버튼이 켜지지 않았습니다(가짜)', outcome: 'failed', submitted: false };
  }
  onStatus?.('posting', { step: 'submit' });
  onStatus?.('verifying', {});
  if (videoId.startsWith('FAILPOST')) {
    onStatus?.('failed', { stage: 'verifying', outcome: 'unknown', error: '결과 불명: 내 댓글이 안 보임(가짜)' });
    return { ok: false, stage: 'verifying', dryRun: false, verified: false, commentText: text, authorName: 'STUB', screenshot: null, error: '결과 불명: 내 댓글이 안 보임(가짜)', outcome: 'unknown', submitted: true };
  }
  onStatus?.('done', { outcome: 'posted' });
  return { ok: true, stage: 'done', dryRun: false, verified: true, commentText: text, authorName: 'STUB', screenshot: null, error: null, outcome: 'posted', submitted: true };
}
`,
  );
  // 글 검사는 실제 부품을 그대로 쓴다 (브라우저를 쓰지 않는 순수 함수)
  writeFileSync(join(stubDir, 'validate.mjs'), `export { validateComment } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'validate.mjs')).href)};
`);
  const logC = join(TMP, 'server-c-log.json');
  const s = startServer({ JG_MODULES_DIR: stubDir, JG_LOG_PATH: logC, STUB_ALLOWED_CHANNEL: realCfg.channels[0].id });
  let sse = null;
  const profileId = realCfg.profiles[0].id;
  const post = (videoId, dryRun, text = TEXT) => call('POST', '/api/post', { body: { videoId, text, profileId, dryRun } });
  let stubConfirmed = false;
  try {
    await s.ready;
    // 서버가 뜬 뒤에 실시간 알림에 붙고, 첫 인사(hello)를 받을 때까지 기다린다
    sse = listenEvents();
    const helloEnd = Date.now() + SERVER_READY_TIMEOUT_MS;
    while (!sse.events.some((e) => e.event === 'hello') && Date.now() < helloEnd) await sleep(POLL_MS);
    await test('GET /api/events — 연결하면 hello(오늘 게시 수) 를 받는다', () => {
      const h = sse.events.find((e) => e.event === 'hello');
      assert.ok(h, 'hello 이벤트 없음');
      assert.equal(typeof h.data.today.count, 'number');
    });

    await test('링크(youtu.be/…?si=)로 /api/draft → 정규화된 ID · 고민·초안·근거 · 가짜 부품 확인', async () => {
      const { status, data } = await call('POST', '/api/draft', { body: { url: 'https://youtu.be/GOOD0000001?si=abc' } });
      assert.equal(status, 200, JSON.stringify(data));
      assert.equal(data.videoId, 'GOOD0000001');
      assert.equal(data.draft.provider, 'stub');
      assert.equal(data.draft.worry, '가짜 고민 한 줄');
      assert.equal(data.source.transcript, 'ok');
      assert.equal(data.check.ok, true, JSON.stringify(data.check));
      assert.equal(data.check.by, 'validate', '실제 validate.mjs 로 검사');
      stubConfirmed = true;
    });
    await test('shorts/ · watch?v= 링크도 같은 영상으로', async () => {
      for (const url of ['youtube.com/shorts/GOOD0000001', 'https://www.youtube.com/watch?v=GOOD0000001&t=3s']) {
        const { status, data } = await call('POST', '/api/draft', { body: { url } });
        assert.equal(status, 200);
        assert.equal(data.videoId, 'GOOD0000001');
      }
    });
    await test('남의 채널 링크 → 403 · 이유(채널 이름) 표시', async () => {
      const { status, data } = await call('POST', '/api/draft', { body: { url: 'https://youtu.be/XFOREIGN001' } });
      assert.equal(status, 403);
      assert.equal(data.code, 'NOT_ALLOWED');
      assert.match(data.error, /남의채널/);
      console.log(`      → "${data.error}"`);
    });

    if (!stubConfirmed) throw new Error('서버가 가짜 부품을 쓰는지 확인하지 못해 게시 시험을 하지 않습니다.');

    await test('남의 채널 영상에 /api/post → 403 (화면을 거치지 않고 바로 불러도 서버가 막음)', async () => {
      const { status, data } = await post('XFOREIGN001', false);
      assert.equal(status, 403);
      assert.equal(data.code, 'NOT_ALLOWED');
    });
    await test('규칙에 안 맞는 댓글(짧음 · 링크 · 브랜드 없음) → 422 · 이유 표시', async () => {
      for (const bad of ['짧은 댓글 운명원', TEXT.replace('운명원', '그곳'), TEXT.slice(0, 50) + ' https://x.com']) {
        const { status, data } = await post('GOOD0000001', true, bad);
        assert.equal(status, 422, bad);
        assert.equal(data.code, 'INVALID_TEXT');
      }
      const r = await post('GOOD0000001', true, '짧은 댓글 운명원');
      console.log(`      → "${r.data.error}"`);
    });
    await test('연습 → 200 · 결과 연습 · 오늘 게시 수 그대로', async () => {
      const before = (await call('GET', '/api/log')).data.today.count;
      const { status, data } = await post('GOOD0000001', true);
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.entry.result, 'practice');
      assert.equal(data.today.count, before);
    });
    await test('실제 게시(가짜 부품) → 성공 · SSE 로 단계(프로필 여는 중 → 입력 n/N → 게시 → 확인)가 실시간으로 온다', async () => {
      const { status, data } = await post('GOOD0000001', false);
      assert.equal(status, 200);
      assert.equal(data.entry.result, 'success');
      assert.equal(data.entry.resultLabel, '성공');
      // 이 게시(jobId)의 알림만 본다 — 앞 시험의 알림이 늦게 섞일 수 있다
      const mine = () => sse.events.filter((e) => e.event === 'post' && e.data?.jobId === data.jobId);
      const end = Date.now() + SERVER_READY_TIMEOUT_MS;
      while (!mine().some((e) => e.data.final) && Date.now() < end) await sleep(POLL_MS);
      const stages = mine().map((e) => e.data.stage);
      for (const st of ['start', 'opening', 'loading', 'typing', 'posting', 'verifying', 'done']) assert.ok(stages.includes(st), `SSE 에 ${st} 없음: ${stages}`);
      const typing = mine().filter((e) => e.data.stage === 'typing');
      assert.ok(typing.length > 1, '입력 진행이 여러 번 와야 함');
      assert.ok(typing.at(-1).data.detail.typed === typing.at(-1).data.detail.total && typing.at(-1).data.detail.total > 0, 'typing 의 typed/total');
      const fin = mine().find((e) => e.data.final);
      assert.ok(fin && fin.data.entry.result === 'success', `최종 이벤트 없음: ${JSON.stringify(stages)}`);
      assert.ok(sse.events.some((e) => e.event === 'log' && e.data?.reason === 'finished'), 'log 갱신 알림');
    });
    await test('같은 영상 두 번째 실제 게시 → 409 · 연습은 된다', async () => {
      const { status, data } = await post('GOOD0000001', false);
      assert.equal(status, 409);
      assert.equal(data.code, 'ALREADY_COMMENTED');
      console.log(`      → "${data.error}"`);
      const p = await post('GOOD0000001', true);
      assert.equal(p.status, 200);
    });
    await test('동시에 두 번 누름 → 하나만 진행 · 다른 하나 409', async () => {
      const rs = await Promise.all([post('SLOW0000001', false), post('SLOW0000001', false)]);
      const st = rs.map((r) => r.status).sort();
      assert.deepEqual(st, [200, 409]);
      const rej = rs.find((r) => r.status === 409).data;
      assert.ok(['BUSY', 'IN_PROGRESS'].includes(rej.code), rej.code);
      const okOne = rs.find((r) => r.status === 200).data;
      assert.equal(okOne.entry.result, 'success');
    });
    await test('게시 버튼 전에 실패 → 실패로 기록 · 다시 하면 된다', async () => {
      const a = await post('FAILPRE0001', false);
      assert.equal(a.status, 200);
      assert.equal(a.data.ok, false);
      assert.equal(a.data.entry.result, 'failed');
      assert.match(a.data.entry.reason, /댓글 창을 찾지 못함/);
      const b = await post('FAILPRE0001', false);
      assert.equal(b.status, 200);
      assert.equal(b.data.entry.result, 'success');
    });
    await test('제출 버튼을 누르기 전 실패(submitted:false) → 실패 · 다시 하면 된다', async () => {
      const a = await post('NOSUBMIT001', false);
      assert.equal(a.data.entry.result, 'failed', a.data.entry.reason);
      const b = await post('NOSUBMIT001', false);
      assert.equal(b.data.entry.result, 'success');
    });
    await test('게시 뒤 확인 실패 → 결과불명으로 기록 · 같은 영상 다시 거부', async () => {
      const a = await post('FAILPOST001', false);
      assert.equal(a.data.entry.result, 'unknown');
      const b = await post('FAILPOST001', false);
      assert.equal(b.status, 409);
      assert.equal(b.data.code, 'ALREADY_COMMENTED');
    });
    await test(`하루 상한(${realCfg.limits.dailyMaxComments}개)에 닿으면 429 · 연습은 된다`, async () => {
      let t = (await call('GET', '/api/log')).data.today;
      let i = 0;
      while (t.count < t.max) {
        i++;
        const id = `CAP${String(i).padStart(8, '0')}`;
        const r = await post(id, false);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        t = r.data.today;
      }
      const over = await post('CAPOVER0001', false);
      assert.equal(over.status, 429);
      assert.equal(over.data.code, 'DAILY_LIMIT');
      console.log(`      → "${over.data.error}"`);
      const p = await post('CAPOVER0001', true);
      assert.equal(p.status, 200);
      assert.equal(p.data.entry.result, 'practice');
    });
    await test('GET /api/log — 시간순 · 결과 네 가지가 모두 들어 있다', async () => {
      const { data } = await call('GET', '/api/log');
      const times = data.entries.map((e) => e.time);
      assert.deepEqual(times, [...times].sort(), '시간순');
      const kinds = new Set(data.entries.map((e) => e.result));
      for (const k of ['success', 'failed', 'unknown', 'practice']) assert.ok(kinds.has(k), `결과 ${k} 없음`);
      assert.ok(!kinds.has('pending'), '끝난 뒤 진행 중이 남으면 안 됨');
      assert.equal(data.today.count, data.today.max);
      const file = JSON.parse(readFileSync(logC, 'utf8'));
      assert.equal(file.length, data.entries.length, '파일과 화면 기록 개수 같음');
    });
  } finally {
    await sse?.stop();
    await stopServer(s);
  }
}

// ── 뒷정리 ───────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });
if (!logExisted && existsSync(LOG_JSON)) rmSync(LOG_JSON);
if (!dataExisted && existsSync(DATA_DIR) && readdirSync(DATA_DIR).length === 0) rmSync(DATA_DIR, { recursive: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과${failed.length ? ` · 실패 ${failed.length}` : ''}`);
console.log(`뒷정리: 임시 폴더 삭제 · data/log.json ${logExisted ? '원래 있던 것 그대로' : existsSync(LOG_JSON) ? '남아 있음(!)' : '없음'}`);
if (failed.length) process.exitCode = 1;
