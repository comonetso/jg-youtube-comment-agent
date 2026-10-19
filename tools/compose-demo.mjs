// 화면 밖 녹화(record-demo.mjs --offscreen) 결과를 한 편의 시연 영상으로 합친다.
//   대시보드 프레임 [처음 → 댓글 달기 누른 직후] + 게시 탭 프레임 + 대시보드 프레임 [돌아온 뒤 → 끝]
// 프레임은 크롬 화면 전송으로 받은 jpg 와 받은 시각(frames.json) — 시각 차이만큼씩 보여 준다.
// 사용: node tools/compose-demo.mjs <marks.json> <게시 프레임 폴더(post-*)>  → marks 옆에 <이름>-final.mp4
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';

const [marksPath, postDir] = process.argv.slice(2).map((p) => p && resolve(p));
if (!marksPath || !postDir) {
  console.error('사용: node tools/compose-demo.mjs <marks.json> <post-프레임 폴더>');
  process.exit(2);
}
const W = 1600, H = 900, FPS = 30;
const CAPTION = "③ [댓글 달기] → 크롬 '유튜브1' 프로필이 열려 한 글자씩 입력 · 게시 · 내 댓글 확인";
const HOLD_POST_END = 6; // 게시 화면 마지막 장면을 붙잡아 두는 초(정한 값)
const CAPTION_SEC = 3.5; // 자막을 띄우는 초(정한 값)
const AFTER_CLICK_MS = 800; // 댓글 달기를 누른 뒤 대시보드를 조금 더 보여 주는 시간(정한 값)

const { dashVideo: dashDir, marks } = JSON.parse(readFileSync(marksPath, 'utf8'));
const at = (name) => marks.find((m) => m.name === name);
const click = at('post-click');
const back = at('dashboard-back') || at('dashboard-back-start');
if (!click?.epoch || !back?.epoch) throw new Error('장면 시각(post-click · dashboard-back)이 없습니다');
const dash = JSON.parse(readFileSync(join(dashDir, 'frames.json'), 'utf8'));
const post = JSON.parse(readFileSync(join(postDir, 'frames.json'), 'utf8'));
if (!dash.frames.length || !post.frames.length) throw new Error('프레임이 비어 있습니다');

const work = join(dirname(marksPath), `_compose-${basename(postDir)}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd: work, stdio: 'inherit' });
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];
const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x111111,setsar=1`;
const fwd = (p) => p.replace(/\\/g, '/');

/** 프레임 목록의 [fromT, toT) 구간을 영상으로. 각 프레임은 다음 프레임까지 보여 주고, 마지막은 toT(또는 hold)까지. */
function framesToVideo(dir, frames, { fromT, toT, holdEnd = 0, vf = fit, out, speed = 1 }) {
  // 구간 시작 시점에 보이던 프레임(시작 전 마지막 프레임)부터 쓴다
  let first = frames.findIndex((f) => f.t >= fromT);
  if (first === -1) first = frames.length - 1;
  if (first > 0 && frames[first].t > fromT) first -= 1;
  const picked = frames.slice(first).filter((f, i) => i === 0 || f.t < toT);
  const lines = [];
  for (let i = 0; i < picked.length; i++) {
    const start = Math.max(picked[i].t, fromT);
    const end = i < picked.length - 1 ? picked[i + 1].t : toT + holdEnd * 1000;
    lines.push(`file '${fwd(join(dir, picked[i].file))}'`, `duration ${Math.max((end - start) / 1000 / speed, 0.001).toFixed(3)}`);
  }
  lines.push(`file '${fwd(join(dir, picked.at(-1).file))}'`); // concat 은 마지막 항목을 한 번 더 적어야 마지막 duration 이 먹는다
  writeFileSync(join(work, `${out}.txt`), lines.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', `${out}.txt`, '-vf', vf, ...enc, `${out}.mp4`]);
  return picked.length;
}

const SPEED_DRAFT = 1.5; // AI 초안을 기다리는 구간 배속(정한 값)
let capNo = 0;
function captionVf(text, sec) {
  const f = `cap${++capNo}.txt`;
  writeFileSync(join(work, f), text, 'utf8');
  return `${fit},drawbox=x=0:y=0:w=iw:h=70:color=black@0.72:t=fill:enable='lt(t,${sec})',` +
    `drawtext=fontfile='C\\:/Windows/Fonts/malgunbd.ttf':textfile=${f}:fontcolor=white:fontsize=30:x=(w-text_w)/2:y=20:enable='lt(t,${sec})'`;
}

// 대시보드 앞부분 — AI 초안을 기다리는 구간은 빠르게(자막으로 알림)
const cuts = [];
const dStart = dash.frames[0].t;
const clickEnd = click.epoch + AFTER_CLICK_MS;
let cur = dStart;
for (const no of [1, 2]) {
  const w = at(`draft${no}-wait`), d = at(`draft${no}-done`);
  if (!w?.epoch || !d?.epoch || w.epoch < cur || d.epoch > clickEnd) continue;
  cuts.push({ fromT: cur, toT: w.epoch });
  cuts.push({ fromT: w.epoch, toT: d.epoch, speed: SPEED_DRAFT, caption: `AI 가 영상의 자막·설명·인기 댓글을 읽고 초안을 쓰는 중 (${SPEED_DRAFT}배속)` });
  cur = d.epoch;
}
cuts.push({ fromT: cur, toT: clickEnd });
const parts = [];
cuts.forEach((c, i) => {
  if (c.toT - c.fromT < 50) return;
  const out = `d${i}`;
  const vf = c.caption ? captionVf(c.caption, (c.toT - c.fromT) / 1000 / (c.speed || 1)) : fit;
  framesToVideo(dashDir, dash.frames, { fromT: c.fromT, toT: c.toT, speed: c.speed || 1, vf, out });
  parts.push(`${out}.mp4`);
});
const postEnd = post.endedAt || post.frames.at(-1).t;
const n2 = framesToVideo(postDir, post.frames, { fromT: post.frames[0].t, toT: postEnd, holdEnd: HOLD_POST_END, vf: captionVf(CAPTION, CAPTION_SEC), out: 'post' });
parts.push('post.mp4');
const n3 = framesToVideo(dashDir, dash.frames, { fromT: back.epoch, toT: dash.endedAt || dash.frames.at(-1).t, holdEnd: 3, out: 'after' });
parts.push('after.mp4');
const n1 = cuts.length;

writeFileSync(join(work, 'all.txt'), parts.map((f) => `file '${f}'`).join('\n'));
const out = join(dirname(marksPath), basename(marksPath).replace(/\.marks\.json$/, '') + '-final.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', 'all.txt', '-c', 'copy', out]);
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim());
console.log(JSON.stringify({ out, seconds: +dur.toFixed(1), parts: parts.length, dashCuts: n1, postFrames: n2, dashAfterFrames: n3 }));
