// 시연용 테스트 영상을 '일부 공개'로 업로드한다(사용자 승인 — 2026-10-19).
// 사용: node tools/upload-test-video.mjs [profileId]
// 단계마다 data/test-video/upload-<단계>.png 캡처. 끝나면 videoId 를 출력한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, DATA_DIR } from '../src/config.mjs';
import { connect, closeAll } from '../src/browser.mjs';
import { TITLE, OUT_NAME } from './test-video-script.mjs';

const cfg = loadConfig();
const id = process.argv[2] || cfg.profiles[0].id;
const profile = cfg.profiles.find((p) => p.id === id);
const dir = join(DATA_DIR, OUT_NAME);
// 시연 영상 등 다른 파일도 올릴 수 있게 — JG_UPLOAD_FILE · JG_UPLOAD_TITLE · JG_UPLOAD_DESC_FILE (없으면 테스트 영상)
const file = process.env.JG_UPLOAD_FILE || join(dir, 'test-video.mp4');
const description = readFileSync(process.env.JG_UPLOAD_DESC_FILE || join(dir, 'description.txt'), 'utf8');
const UPLOAD_TITLE = process.env.JG_UPLOAD_TITLE || TITLE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await connect({ profile });
const page = await browser.newWindow('https://studio.youtube.com/');
const raw = page.raw;
const shot = (name) => raw.screenshot({ path: join(dir, `upload-${name}.png`) }).catch(() => {});
let step = 'open';
try {
  await raw.waitForURL(/studio\.youtube\.com\/channel\/UC/, { timeout: 30000 });
  const channelId = raw.url().match(/\/channel\/(UC[\w-]{22})/)[1];
  step = 'dialog';
  await raw.goto(`https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud`);
  const input = raw.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 30000 });
  await shot('1-dialog');

  step = 'file';
  await input.setInputFiles(file);
  const titleBox = raw.locator('#title-textarea #textbox');
  await titleBox.waitFor({ state: 'visible', timeout: 60000 });
  await sleep(1500);

  step = 'title';
  await titleBox.click();
  await raw.keyboard.press('Control+A');
  await raw.keyboard.insertText(UPLOAD_TITLE);

  step = 'description';
  const descBox = raw.locator('#description-textarea #textbox');
  await descBox.click();
  const lines = description.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await raw.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await raw.keyboard.press('Enter');
  }

  step = 'kids';
  await raw.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').click();
  await sleep(500);

  step = 'link';
  const link = await raw
    .locator('ytcp-video-info a, .video-url-fadeable a')
    .first()
    .getAttribute('href', { timeout: 30000 })
    .catch(() => null);
  const videoId = link?.match(/(?:youtu\.be\/|v=)([\w-]{11})/)?.[1] || null;
  await shot('2-details');

  for (const n of [1, 2, 3]) {
    step = `next${n}`;
    await raw.locator('#next-button').click();
    await sleep(1200);
  }

  step = 'unlisted';
  await raw.locator('tp-yt-paper-radio-button[name="UNLISTED"]').click();
  await sleep(500);
  await shot('3-visibility');

  step = 'save';
  await raw.locator('#done-button').click();
  // 저장 뒤에는 '동영상 처리 중'(SD 처리 전) 또는 '동영상 게시됨' 창이 뜬다 — 요소 이름이 매번 달라(3회 실측) 글자로 판정한다.
  await raw.waitForFunction(() => /동영상 처리 중|동영상 게시됨|동영상이 게시되었/.test(document.body.innerText), null, { timeout: 60000 });
  await shot('4-done');
  console.log(JSON.stringify({ ok: true, channelId, videoId, url: videoId ? `https://youtu.be/${videoId}` : link, visibility: 'unlisted' }));
} catch (e) {
  await shot(`fail-${step}`);
  console.error(JSON.stringify({ ok: false, step, error: e.message.split('\n')[0] }));
  process.exitCode = 1;
} finally {
  await sleep(1500);
  await closeAll();
}
