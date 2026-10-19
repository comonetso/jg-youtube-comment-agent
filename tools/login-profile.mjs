// 전용 크롬 프로필에 구글 로그인을 해 두는 도구.
// 자동 조종 없이 그냥 크롬을 그 프로필 폴더로 띄운다(자동 조종 중인 크롬은 구글이 로그인을 막을 수 있다).
// 사용: node tools/login-profile.mjs [profileId]   (기본 youtube1)
// 로그인을 마치면 그 크롬 창을 닫는다. 이후 대시보드가 같은 폴더로 로그인된 크롬을 연다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { resolveUserDataDir } from '../src/browser.mjs';

const cfg = loadConfig();
const id = process.argv[2] || cfg.profiles[0].id;
const profile = cfg.profiles.find((p) => p.id === id);
if (!profile) {
  console.error(`프로필 '${id}' 가 config.json 에 없습니다. 있는 것: ${cfg.profiles.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const candidates = [
  process.env.CHROME_PATH,
  join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error('Google Chrome 을 찾지 못했습니다. CHROME_PATH 환경변수로 chrome 실행 파일 경로를 알려 주세요.');
  process.exit(1);
}

const userDataDir = resolveUserDataDir(profile);
mkdirSync(userDataDir, { recursive: true });
const loginUrl = 'https://accounts.google.com/ServiceLogin?hl=ko&continue=https%3A%2F%2Fwww.youtube.com%2F%3Fhl%3Dko';
const child = spawn(
  chrome,
  [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--lang=ko-KR', loginUrl],
  { detached: true, stdio: 'ignore' },
);
child.unref();
console.log(`'${profile.name}' 전용 크롬을 열었습니다.`);
console.log(`프로필 폴더: ${userDataDir}`);
console.log('그 창에서 구글 로그인 → 유튜브 화면이 뜨면 창을 닫아 주세요.');
