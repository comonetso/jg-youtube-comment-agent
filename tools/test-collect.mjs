// 수집 시험 — 실제 브라우저(뒤쪽 새 창)로 영상을 수집해 data/samples/<videoId>.json 에 저장한다. 읽기 전용(게시 없음).
//
//   node tools/test-collect.mjs                 지정 5채널에서 채널마다 라이브가 아닌 최신 영상 1개
//   node tools/test-collect.mjs <id> [<id>...]  지정한 영상만(라이브여도 수집). 지정 채널이 아닌 영상은 data/samples/_offlist/
//   node tools/test-collect.mjs --offline       브라우저 없이 해석 함수·페이지 함수 문법만 점검
//
// 브라우저: 크롬 전용 프로필(src/browser.mjs, config.profiles[0]). 크롬 창이 화면에 뜬다.
//   같은 프로필은 한 프로세스만 열 수 있다 — 서버(node src/server.mjs)·다른 시험과 동시에 돌리지 않는다.
// 결과 표는 콘솔과 data/samples/_summary.json 에 남는다(콘솔 한글이 깨질 때 파일로 확인).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, DATA_DIR, ROOT } from '../src/config.mjs';
import { fetchLatestVideos } from '../src/feed.mjs';
import {
  collectVideoContext, getVideoMeta, parseLikes, parseCount, hmsToSeconds, parseJson3, pickTrack,
  COLLECT_PRELOAD, COLLECT_PAGE_FUNCTIONS,
} from '../src/collect.mjs';

const MAX_TRIES_PER_CHANNEL = 15; // 채널마다 라이브가 아닌 영상을 찾을 때 볼 최대 영상 수(RSS 가 채널당 15개를 준다)

// ── 1) 브라우저 없이 점검 ──
assert.equal(parseLikes('나와 사용자 24명이 이 댓글을 좋아함', '24'), 24);
assert.equal(parseLikes('나와 사용자 1,234명이 이 댓글을 좋아함', '1.2천'), 1234);
assert.equal(parseLikes('', '1.2천'), 1200);
assert.equal(parseLikes('', '3.4만'), 34000);
assert.equal(parseLikes('', ''), 0);
assert.equal(parseCount('1.5K'), 1500);
assert.equal(hmsToSeconds('0:00'), 0);
assert.equal(hmsToSeconds('13:23'), 803);
assert.equal(hmsToSeconds('1:02:03'), 3723);
assert.deepEqual(
  parseJson3(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: '안녕' }, { utf8: ' 하세요' }] }, { tStartMs: 1500, aAppend: 1, segs: [{ utf8: '\n' }] }, { tStartMs: 2345 }, { tStartMs: 2346, segs: [{ utf8: '둘째\n줄' }] }] })),
  [{ t: 0, text: '안녕 하세요' }, { t: 2.35, text: '둘째 줄' }],
);
assert.equal(pickTrack([{ languageCode: 'en', kind: 'asr' }, { languageCode: 'ko', kind: 'asr' }, { languageCode: 'ko', kind: '' }]).kind, '');
assert.equal(pickTrack([{ languageCode: 'en', kind: 'asr' }, { languageCode: 'ja', kind: '' }]).languageCode, 'ja');
assert.equal(pickTrack([]), null);
// 페이지로 보내는 글(PRELOAD·evaluate 식)이 문법상 맞는지 — 실행하지 않고 해석만 한다
new Function(COLLECT_PRELOAD);
for (const fn of COLLECT_PAGE_FUNCTIONS) new Function(`return (${fn.toString()})(...[]);`);
console.log(`브라우저 없는 점검 통과 (해석 함수 + 페이지 함수 ${COLLECT_PAGE_FUNCTIONS.length}개 문법)`);

const args = process.argv.slice(2);
if (args.includes('--offline')) process.exit(0);

// ── 2) 브라우저 연결 준비 ──
const cfg = loadConfig();
const { connect, closeAll } = await import('../src/browser.mjs');
const browserOpts = { connect, profile: cfg.profiles[0] };
const ids = args.filter((a) => !a.startsWith('--'));
const channelIds = new Set(cfg.channels.map((c) => c.id));

let plan; // [{ channelName, candidates: [videoId...], skipLive }]
if (ids.length) {
  plan = ids.map((id) => ({ channelName: '(지정)', candidates: [id], skipLive: false }));
} else {
  const { videos, errors } = await fetchLatestVideos(cfg.channels);
  if (errors.length) console.log('RSS 오류:', JSON.stringify(errors));
  plan = cfg.channels.map((c) => ({
    channelName: c.name,
    candidates: videos.filter((v) => v.channelId === c.id).slice(0, MAX_TRIES_PER_CHANNEL).map((v) => v.videoId),
    skipLive: true,
  }));
}

const samplesDir = join(DATA_DIR, 'samples');
const offlistDir = join(samplesDir, '_offlist');
await mkdir(offlistDir, { recursive: true });

// ── 3) 수집 ──
const rows = [];
try {
  for (const p of plan) {
    for (const videoId of p.candidates) {
      const row = { videoId, plannedChannel: p.channelName };
      // 영상 정보만 먼저(가벼움) — 라이브 거르기 + getVideoMeta 시간 재기
      const m0 = Date.now();
      try {
        const meta = await getVideoMeta(videoId, browserOpts);
        row.metaMs = Date.now() - m0;
        row.metaCheck = meta.videoId === videoId && !!meta.title && !!meta.channelId ? 'ok' : 'bad';
        if (p.skipLive && meta.isLive) {
          row.skipped = '라이브 — 다음 영상으로';
          row.channel = meta.channelName;
          row.isLive = true;
          rows.push(row);
          console.log(`건너뜀(라이브) ${videoId}`);
          continue;
        }
      } catch (e) {
        row.metaMs = Date.now() - m0;
        row.error = `getVideoMeta: ${e.message}`;
        rows.push(row);
        console.log(`실패 ${videoId}: ${row.error}`);
        continue;
      }

      const t0 = Date.now();
      const marks = {};
      try {
        const ctx = await collectVideoContext(videoId, {
          ...browserOpts,
          onStatus: (stage, d) => {
            marks[d?.phase ? `${stage}${d.phase === 'end' ? 'End' : 'Start'}` : stage] = Date.now() - t0;
          },
        });
        const totalMs = Date.now() - t0;
        const allowed = channelIds.has(ctx.channelId);
        Object.assign(row, {
          channel: ctx.channelName,
          allowedChannel: allowed,
          title: ctx.title.slice(0, 40),
          isLive: ctx.isLive,
          publishedAt: ctx.publishedAt,
          transcript: ctx.transcript.status,
          tSource: ctx.transcript.source,
          tLang: ctx.transcript.lang,
          tKind: ctx.transcript.kind,
          tChars: ctx.transcript.text.length,
          tSegments: ctx.transcript.segments.length,
          tLastSec: ctx.transcript.segments.at(-1)?.t ?? null,
          tError: ctx.transcript.error,
          comments: ctx.topComments.length,
          cStatus: ctx.comments.status,
          cReason: ctx.comments.reason,
          cSort: ctx.comments.sort,
          cCountText: ctx.comments.countText,
          cDroppedEmpty: ctx.comments.droppedEmpty,
          cPinned: ctx.topComments.filter((c) => c.pinned).length,
          cMaxLikes: ctx.topComments.reduce((a, c) => Math.max(a, c.likes), 0),
          openToMetaMs: marks.meta ?? null,
          commentsMs: marks.commentsEnd != null && marks.commentsStart != null ? marks.commentsEnd - marks.commentsStart : null,
          transcriptMs: marks.transcriptEnd != null && marks.transcriptStart != null ? marks.transcriptEnd - marks.transcriptStart : null,
          totalMs,
        });
        const file = join(allowed ? samplesDir : offlistDir, `${videoId}.json`);
        await writeFile(file, JSON.stringify(ctx, null, 2), 'utf8');
        row.saved = relative(ROOT, file).replace(/\\/g, '/');
        rows.push(row);
        console.log(`저장 ${row.saved}  자막 ${row.transcript}(${row.tChars}자, ${row.tSource || '-'}) 댓글 ${row.comments}개 ${totalMs}ms`);
        break; // 이 채널은 끝
      } catch (e) {
        row.error = e.message;
        row.totalMs = Date.now() - t0;
        rows.push(row);
        console.log(`실패 ${videoId}: ${e.message}`);
      }
    }
  }
} finally {
  await closeAll();
}

// ── 4) 요약 ──
const saved = rows.filter((r) => r.saved);
const summary = {
  at: new Date().toISOString(),
  browser: 'chrome-profile',
  saved: saved.length,
  distinctAllowedChannels: new Set(saved.filter((r) => r.allowedChannel).map((r) => r.channel)).size,
  rows,
};
await writeFile(join(samplesDir, '_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.table(
  rows.map((r) => ({
    id: r.videoId,
    채널: r.channel ?? r.plannedChannel,
    라이브: r.isLive,
    자막: r.transcript ?? '-',
    경로: r.tSource ?? '-',
    언어: r.tLang ? `${r.tLang}${r.tKind === 'asr' ? '(자동)' : ''}` : '-',
    자막글자: r.tChars ?? '-',
    댓글: r.comments ?? '-',
    댓글상태: r.cStatus ?? '-',
    정보ms: r.metaMs,
    수집ms: r.totalMs,
    비고: r.error || r.skipped || r.tError || r.cReason || '',
  })),
);
console.log(`저장 ${summary.saved}개 · 서로 다른 지정 채널 ${summary.distinctAllowedChannels}곳 · 요약 data/samples/_summary.json`);
