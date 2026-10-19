// 시연용 테스트 영상 만들기 — 연애 고민 독백(윈도우 한국어 음성) + 자막이 뜨는 30초 영상.
// 결과: data/test-video/test-video.mp4 · subs.srt · description.txt
// 사용: node tools/make-test-video.mjs   (Windows · ffmpeg · 한국어 음성 Heami 필요)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/config.mjs';

import { TITLE, LINES, OUT_NAME } from './test-video-script.mjs';
const GAP = 0.4; // 문장 사이 쉼(초)

const out = join(DATA_DIR, OUT_NAME);
const tmp = join(out, 'tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// 1) 문장별 음성 — PowerShell System.Speech (문장은 UTF-8 파일로 넘긴다)
writeFileSync(join(tmp, 'lines.txt'), LINES.join('\n'), 'utf8');
const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Heami Desktop')
$s.Rate = 0
$lines = Get-Content -LiteralPath '${join(tmp, 'lines.txt')}' -Encoding UTF8
for ($i = 0; $i -lt $lines.Count; $i++) {
  $s.SetOutputToWaveFile((Join-Path '${tmp}' ("line{0:D2}.wav" -f $i)))
  $s.Speak($lines[$i])
}
$s.SetOutputToNull()
`;
writeFileSync(join(tmp, 'tts.ps1'), '﻿' + ps, 'utf8');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(tmp, 'tts.ps1')], { stdio: 'inherit' });

// 2) 길이 재서 자막(SRT) 만들기
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const ts = (sec) => {
  const ms = Math.round(sec * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};
let t = 0.6;
const srt = [];
const spans = [];
const concat = [`file 'silence_lead.wav'`];
LINES.forEach((line, i) => {
  const f = `line${String(i).padStart(2, '0')}.wav`;
  const d = dur(join(tmp, f));
  srt.push(`${i + 1}\n${ts(t)} --> ${ts(t + d)}\n${line}\n`);
  spans.push([t, t + d]);
  writeFileSync(join(tmp, `cap${String(i).padStart(2, '0')}.txt`), line, 'utf8');
  concat.push(`file '${f}'`, `file 'silence_gap.wav'`);
  t += d + GAP;
});
const total = t + 0.6;
writeFileSync(join(out, 'subs.srt'), srt.join('\n'), 'utf8');
writeFileSync(join(tmp, 'concat.txt'), concat.join('\n'), 'utf8');

const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd: tmp, stdio: 'inherit' });
ff(['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '0.6', 'silence_lead.wav']);
ff(['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(GAP), 'silence_gap.wav']);
ff(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-ar', '44100', '-ac', '2', 'voice.wav']);

// 3) 영상 — 짙은 배경 + 제목 + 문장 자막(맑은 고딕, 문장마다 그 시간에만 표시)
writeFileSync(join(tmp, 'title.txt'), '요즘 연애 고민 하나만 들어 주세요', 'utf8');
writeFileSync(join(tmp, 'tag.txt'), '연애 고민 · 테스트 영상', 'utf8');
const font = "fontfile='C\\:/Windows/Fonts/malgun.ttf'";
const vf = [
  "drawtext=fontfile='C\\:/Windows/Fonts/malgunbd.ttf':textfile=title.txt:fontcolor=white:fontsize=46:x=(w-text_w)/2:y=150",
  `drawtext=${font}:textfile=tag.txt:fontcolor=0xC9B8FF:fontsize=26:x=(w-text_w)/2:y=225`,
  ...spans.map(
    ([a, b], i) =>
      `drawtext=${font}:textfile=cap${String(i).padStart(2, '0')}.txt:fontcolor=white:fontsize=36:borderw=2:bordercolor=black:x=(w-text_w)/2:y=420:enable='between(t\\,${a.toFixed(2)}\\,${b.toFixed(2)})'`,
  ),
].join(',');
ff([
  '-f', 'lavfi', '-i', `color=c=0x2B2440:s=1280x720:d=${total.toFixed(2)}:r=30`,
  '-i', 'voice.wav',
  '-vf', vf,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest',
  join(out, 'test-video.mp4'),
]);

writeFileSync(
  join(out, 'description.txt'),
  `${LINES.join('\n')}\n\n※ 채용 과제(유튜브 댓글 에이전트) 시연용 테스트 영상입니다.`,
  'utf8',
);
rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ file: join(out, 'test-video.mp4'), seconds: Number(total.toFixed(1)), title: TITLE }));
