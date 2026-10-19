// 시험: 게시 담당(src/post.mjs)을 dryRun 으로 끝까지 한 번 돌린다. 🔴 실제 게시 안 함.
//   node tools/test-post.mjs            → 지정 채널 RSS 최신 영상 중 라이브가 아닌 첫 영상
//   node tools/test-post.mjs <videoId>  → 그 영상으로
// dryRun 은 코드에 true 로 고정돼 있고 바꾸는 옵션이 없다.
// 결과 전체는 data/test-post-result.json 에 쓴다(콘솔 한글 깨짐 대비).
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, DATA_DIR } from '../src/config.mjs';
import { fetchLatestVideos } from '../src/feed.mjs';
import { postComment } from '../src/post.mjs';
import { closeAll } from '../src/browser.mjs';

const TEXT = '시험 입력입니다 한 글자씩 들어가는지 확인합니다';
const MAX_CANDIDATES = 10; // 라이브 여부를 확인해 볼 최신 영상 수 — 근거 없이 정한 값

const cfg = loadConfig();

async function isLiveContent(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ko`, { headers: { 'accept-language': 'ko-KR,ko;q=0.9' } });
  const html = await res.text();
  const m = html.match(/"isLiveContent":(true|false)/);
  return m ? m[1] === 'true' : null; // null = 판단 불가
}

async function pickVideo() {
  const argId = process.argv[2];
  const { videos, errors } = await fetchLatestVideos(cfg.channels);
  if (argId) return { video: videos.find((v) => v.videoId === argId) || { videoId: argId, title: '(직접 지정)', channelName: '?' }, feed: { count: videos.length, errors }, checked: [] };
  const checked = [];
  for (const v of videos.slice(0, MAX_CANDIDATES)) {
    const live = await isLiveContent(v.videoId).catch(() => null);
    checked.push({ videoId: v.videoId, channel: v.channelName, live });
    if (live === false) return { video: v, feed: { count: videos.length, errors }, checked };
  }
  throw new Error(`최신 ${MAX_CANDIDATES}개 중 라이브가 아닌 영상을 찾지 못했습니다`);
}

const t0 = Date.now();
const { video, feed, checked } = await pickVideo();
console.log(`video ${video.videoId} | ${video.channelName} | ${video.title}`);

const events = [];
let lastTyped = 0;
const onStatus = (stage, detail) => {
  const at = Date.now();
  // 타이핑은 글자마다 오므로 처음·끝·10글자마다만 화면에 찍고, 기록은 전부 남긴다
  events.push({ ms: at - t0, stage, detail });
  if (stage === 'typing' && detail?.typed !== undefined && !detail?.step) {
    lastTyped = detail.typed;
    if (detail.typed !== 0 && detail.typed !== detail.total && detail.typed % 10 !== 0) return;
  }
  console.log(`[${String(at - t0).padStart(6)}ms] ${stage} ${detail ? JSON.stringify(detail) : ''}`);
};

const runStart = Date.now();
const result = await postComment({ videoId: video.videoId, text: TEXT, dryRun: true, onStatus });
const runMs = Date.now() - runStart;

// 단계별 걸린 시간: 한 단계(stage+step)가 시작된 시각부터 다음 단계 시작까지
const marks = [];
for (const e of events) {
  const key = e.detail?.step ? `${e.stage}:${e.detail.step}` : e.stage;
  if (!marks.length || marks[marks.length - 1].key !== key) marks.push({ key, startMs: e.ms });
}
const endMs = Date.now() - t0;
const stageTimes = marks.map((m, i) => ({ step: m.key, ms: (marks[i + 1]?.startMs ?? endMs) - m.startMs }));

// 시험이 띄운 크롬(게시용 프로필)을 닫는다 — 연습은 창을 남기지 않는다(post.mjs)
await closeAll();

const checks = {
  ok: result.ok === true,
  dryRun: result.dryRun === true,
  notSubmitted: result.submitted === false,
  notVerified: result.verified === false,
  noPostingStage: !events.some((e) => e.stage === 'posting' || e.stage === 'verifying'),
  typedAll: lastTyped === Array.from(TEXT).length,
  textMatched: result.commentText === TEXT,
};
const pass = Object.values(checks).every(Boolean);

const report = {
  when: new Date().toISOString(),
  video: { videoId: video.videoId, title: video.title, channel: video.channelName, publishedAt: video.publishedAt },
  feed,
  liveChecked: checked,
  text: TEXT,
  chars: Array.from(TEXT).length,
  typingDelayMs: cfg.typing?.delayMs ?? 90,
  runMs,
  stageTimes,
  result,
  checks,
  pass,
  events,
};
await mkdir(DATA_DIR, { recursive: true });
const out = join(DATA_DIR, 'test-post-result.json');
await writeFile(out, JSON.stringify(report, null, 1), 'utf8');

console.log('stageTimes', JSON.stringify(stageTimes));
console.log('checks', JSON.stringify(checks));
console.log(pass ? 'PASS' : 'FAIL', `runMs=${runMs}`, `report=${out}`);
process.exitCode = pass ? 0 : 1;
