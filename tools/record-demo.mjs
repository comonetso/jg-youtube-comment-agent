// 시연 영상 녹화 — 대시보드를 화면 가득 띄워 ①→②→③ 순서로 누르고, 주 모니터를 ffmpeg 로 녹화한다.
// 전제: 대시보드 서버가 떠 있다(npm start). 녹화 중에는 마우스·키보드를 건드리지 않는다.
// 사용: node tools/record-demo.mjs [--rehearsal] [--no-record] [--video <testVideoId>]
//   --rehearsal : [댓글 달기] 대신 [연습]을 눌러 게시하지 않는다(리허설용)
//   --no-record : 녹화 없이 순서만 돌린다
import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { loadConfig, DATA_DIR, ROOT } from '../src/config.mjs';

const args = process.argv.slice(2);
const REHEARSAL = args.includes('--rehearsal');
const RECORD = !args.includes('--no-record');
// --offscreen: 사용자 화면에 아무것도 띄우지 않고 녹화 — 대시보드는 안 보이는 크롬의 페이지 영상, 게시 화면은 서버가 따로 받는다(JG_RECORD_POST_DIR).
//   합치기는 tools/compose-demo.mjs. 서버는 JG_BROWSER_MODE=offscreen JG_OFFSCREEN_SIZE=1600,900 JG_RECORD_POST_DIR=<폴더> 로 띄운다.
const OFFSCREEN = args.includes('--offscreen');
const DASH_SIZE = { width: 1600, height: 900 };
const cfg = loadConfig();
const VIDEO = args[args.indexOf('--video') + 1] && args.includes('--video') ? args[args.indexOf('--video') + 1] : cfg.testVideos.at(-1).videoId;
const URL_DASH = `http://127.0.0.1:${process.env.JG_PORT || 4310}/`;
const CHANNEL_VIDEO = process.env.JG_DEMO_CHANNEL_VIDEO || 'k_0c0m0Hk5k'; // 외롭여 — 자막이 읽히는 것을 확인한 영상
const OFF_LIST = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // 허용 채널이 아닌 영상(거부 시연용)
// 녹화 영역 — 주 모니터(이 PC 실측 1834x1032 @0,0). 다른 PC 는 JG_REC_SIZE=WxH 로.
const [REC_W, REC_H] = (process.env.JG_REC_SIZE || '1834x1032').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const outDir = join(DATA_DIR, 'recording');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `demo-${stamp}${REHEARSAL ? '-rehearsal' : ''}.mp4`);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// 화면에 보이는 마우스 표시 — Playwright 클릭은 실제 커서를 움직이지 않아서, 무엇을 누르는지 영상에 보이게 한다
const CURSOR_SCRIPT = `(() => {
  const mk = () => {
    if (document.getElementById('__demoCursor')) return;
    const c = document.createElement('div');
    c.id = '__demoCursor';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '60px', top: '60px', zIndex: 2147483647, pointerEvents: 'none', transition: 'left .6s ease, top .6s ease' });
    const ring = document.createElement('div');
    ring.id = '__demoRing';
    Object.assign(ring.style, { position: 'fixed', width: '36px', height: '36px', marginLeft: '-14px', marginTop: '-14px', borderRadius: '50%', border: '3px solid #2563eb', opacity: 0, zIndex: 2147483646, pointerEvents: 'none', transition: 'opacity .25s, transform .4s', transform: 'scale(.5)' });
    document.body.append(c, ring);
  };
  window.__demoMove = (sel) => {
    mk();
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const r = el.getBoundingClientRect();
    const c = document.getElementById('__demoCursor');
    c.style.left = r.left + Math.min(r.width / 2, 60) + 'px';
    c.style.top = r.top + r.height / 2 + 'px';
    return true;
  };
  window.__demoPulse = () => {
    const c = document.getElementById('__demoCursor');
    const ring = document.getElementById('__demoRing');
    ring.style.left = c.style.left; ring.style.top = c.style.top;
    ring.style.opacity = 1; ring.style.transform = 'scale(1.2)';
    setTimeout(() => { ring.style.opacity = 0; ring.style.transform = 'scale(.5)'; }, 450);
  };
  addEventListener('DOMContentLoaded', mk);
})();`;

async function demoClick(page, selector, { pause = 700 } = {}) {
  await page.waitForSelector(selector, { state: 'visible', timeout: 30000 });
  await page.evaluate((s) => window.__demoMove(s), selector);
  await sleep(900); // 커서가 움직이는 시간(.6초) + 여유
  await page.evaluate(() => window.__demoPulse());
  await page.click(selector);
  await sleep(pause);
}

async function demoType(page, selector, text) {
  await page.evaluate((s) => window.__demoMove(s), selector);
  await sleep(800);
  await page.click(selector);
  await page.keyboard.type(text, { delay: 35 });
}

// ── 녹화 시작 ─────────────────────────────────────────────
let rec = null;
let recStart = 0;
const marks = []; // 녹화 시작 기준 초 — 후처리(북마크 줄 흐림 구간)에 쓴다
const mark = (name) => { if (recStart) marks.push({ name, sec: +((Date.now() - recStart) / 1000).toFixed(2), epoch: Date.now() }); };
function startRecording() {
  if (OFFSCREEN) { recStart = Date.now(); dashCast?.start(); log('녹화(화면 밖 프레임) 시작', dashVideoDir); return; }
  rec = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', '30', '-offset_x', '0', '-offset_y', '0', '-video_size', `${REC_W}x${REC_H}`, '-draw_mouse', '0', '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outFile,
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  recStart = Date.now();
  log('녹화 시작', outFile);
}
async function stopRecording() {
  if (OFFSCREEN) return;
  if (!rec) return;
  rec.stdin.write('q');
  await new Promise((r) => rec.once('exit', r));
  log('녹화 끝', outFile);
}

// ── 시연 ─────────────────────────────────────────────────
const browser = await chromium.launch({
  channel: 'chrome', headless: OFFSCREEN,
  ignoreDefaultArgs: ['--enable-automation'], // 대시보드 창 위 '자동화 제어 중' 알림줄을 숨긴다(로컬 대시보드 화면용)
  args: ['--window-position=0,0', '--start-maximized', '--lang=ko-KR'],
});
const dashVideoDir = join(outDir, `dash-${stamp}`);
const ctx = await browser.newContext(OFFSCREEN ? { viewport: DASH_SIZE, locale: 'ko-KR' } : { viewport: null, locale: 'ko-KR' });
await ctx.addInitScript({ content: CURSOR_SCRIPT });
const page = await ctx.newPage();
// 화면 밖 녹화 — 대시보드 화면을 크롬 화면 전송(Page.startScreencast)으로 받아 프레임과 받은 시각을 저장한다
// (Playwright 영상 녹화는 별도 ffmpeg 를 내려받아야 해서 쓰지 않는다)
let dashCast = null;
if (OFFSCREEN) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(dashVideoDir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on('Page.screencastFrame', (f) => {
    const file = `f${String(++n).padStart(5, '0')}.jpg`;
    frames.push({ file, t: Date.now() });
    writeFile(join(dashVideoDir, file), Buffer.from(f.data, 'base64')).catch(() => {});
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  dashCast = {
    start: () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: DASH_SIZE.width, maxHeight: DASH_SIZE.height, everyNthFrame: 2 }),
    async stop() { await cdp.send('Page.stopScreencast').catch(() => {}); await writeFile(join(dashVideoDir, 'frames.json'), JSON.stringify({ frames, endedAt: Date.now() })); },
  };
}
// 창 다루기 — 윈도우 기능(tools/winctl.ps1)으로 제목이 맞는 창을 주 모니터에 최대화해 맨 앞으로 올린다.
// 크롬 명령(Browser.setWindowBounds)으로 옮기면 창이 주 모니터 밖으로 가 버렸다(실측: 녹화에 바탕화면만 찍힘).
const DASH_TITLE = '유튜브 댓글 에이전트';
function winctl(title) {
  if (OFFSCREEN) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'winctl.ps1'), '-Title', title], { windowsHide: true }, (err, out) =>
      resolve(!err && String(out).startsWith('ok')));
  });
}
async function bringUp(title, { timeoutMs = 15000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await winctl(title)) return true;
    await sleep(700);
  }
  log('창을 못 찾음:', title);
  return false;
}
async function frontMaximize() {
  await page.bringToFront();
  await bringUp(DASH_TITLE);
}
const VIDEO_TITLE_PART = (cfg.testVideos.find((v) => v.videoId === VIDEO)?.title || '').split('|')[0].trim().slice(0, 12);

try {
  await page.goto(URL_DASH, { waitUntil: 'load' });
  if (!(await bringUp(DASH_TITLE))) throw new Error('대시보드 창을 앞으로 가져오지 못해 녹화를 시작하지 않습니다');
  await sleep(1500);
  if (RECORD) startRecording();
  await sleep(4000); // 첫 화면 — 세 칸과 안내문

  // ① 영상 불러오기
  await demoClick(page, '#btnLoad');
  await page.waitForFunction(() => /영상 \d+개를 불러왔/.test(document.body.innerText), null, { timeout: 30000 });
  await sleep(2000);
  await page.evaluate(() => { const l = document.querySelector('#videoList'); l?.scrollBy({ top: 520, behavior: 'smooth' }); });
  await sleep(2500);
  await page.evaluate(() => { const l = document.querySelector('#videoList'); l?.scrollTo({ top: 0, behavior: 'smooth' }); });
  await sleep(1200);

  // ② 지정 채널 영상 — AI 가 자막 속 실제 말을 짚는 초안 (남의 영상이라 게시는 하지 않는다)
  let draftNo = 0;
  const waitDraft = async (prev) => {
    const no = ++draftNo;
    log('초안 기다리는 중');
    mark(`draft${no}-wait`);
    await page.waitForFunction((p) => { const t = document.querySelector('#commentText'); return t && t.value.trim().length > 20 && t.value !== p; }, prev, { timeout: 180000 });
    mark(`draft${no}-done`);
  };
  await demoClick(page, `#videoList [data-id="${CHANNEL_VIDEO}"]`);
  setTimeout(() => frontMaximize(), 1500);
  await waitDraft('');
  await frontMaximize();
  await sleep(1200);
  await page.evaluate(() => window.__demoMove('#worry'));
  await sleep(2500);
  await page.evaluate(() => window.__demoMove('#evidenceList'));
  await sleep(6000);

  // 운영 규칙 — 허용 채널이 아닌 링크는 막는다
  await demoType(page, '#linkInput', OFF_LIST);
  await demoClick(page, '#linkForm button');
  setTimeout(() => frontMaximize(), 1500);
  await page.waitForFunction(() => (document.querySelector('#linkError')?.innerText || '').trim().length > 0, null, { timeout: 30000 }).catch(() => {});
  await frontMaximize();
  await page.evaluate(() => window.__demoMove('#linkError'));
  await sleep(4000);

  // ② 녹화용 테스트 영상 — 초안
  const prevDraft = await page.$eval('#commentText', (t) => t.value).catch(() => '');
  await page.evaluate(() => document.querySelector('#videoList')?.scrollTo({ top: 0, behavior: 'smooth' }));
  await demoClick(page, `#videoList [data-id="${VIDEO}"]`);
  setTimeout(() => frontMaximize(), 1500);
  await waitDraft(prevDraft);
  await frontMaximize();
  await sleep(1200);
  await page.evaluate(() => window.__demoMove('#commentText'));
  await sleep(5500);

  // ③ 댓글 달기 (리허설이면 연습) — '유튜브1' 크롬이 열려 한 글자씩 입력 → 게시 → 내 댓글 확인
  await demoClick(page, REHEARSAL ? '#btnPractice' : '#btnPost', { pause: 200 });
  log(REHEARSAL ? '연습 게시 중' : '실제 게시 중');
  if (VIDEO_TITLE_PART) bringUp(VIDEO_TITLE_PART, { timeoutMs: 30000 }).then((ok) => { mark('youtube-window-front'); log('유튜브1 창', ok ? '앞으로' : '못 찾음'); });
  mark('post-click');
  await page.waitForFunction(
    (reh) => (reh ? /연습 완료|연습 중 멈춤|실패/ : /게시 완료|결과불명|실패/).test(
      [document.querySelector('#progressTitle')?.innerText, document.querySelector('#postResult')?.innerText].join(' '),
    ),
    REHEARSAL, { timeout: 180000 },
  );
  await sleep(5000); // 유튜브1 창에 내 댓글이 보이는 채로 머문다

  // 대시보드로 돌아와 결과 · 기록
  mark('dashboard-back-start');
  await frontMaximize();
  mark('dashboard-back');
  await sleep(1500);
  await page.evaluate(() => window.__demoMove('#postResult'));
  await sleep(3000);
  await page.evaluate(() => window.__demoMove('#logTable'));
  await sleep(6000);
} catch (e) {
  log('시연 중 오류:', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await stopRecording();
  let dashVideo = null;
  if (OFFSCREEN && dashCast) { await dashCast.stop(); dashVideo = dashVideoDir; log('대시보드 프레임', dashVideo); }
  if (RECORD) { const { writeFileSync } = await import('node:fs'); writeFileSync(outFile.replace(/.mp4$/, '.marks.json'), JSON.stringify({ recStart, dashVideo, marks }, null, 1)); log('장면 시각', JSON.stringify(marks)); }
  await browser.close().catch(() => {});
}
