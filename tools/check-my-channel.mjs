// 로그인한 계정의 유튜브 채널과 올린 영상 목록을 읽는다. 읽기만 한다.
// 사용: node tools/check-my-channel.mjs [profileId]
import { loadConfig } from '../src/config.mjs';
import { connect, closeAll } from '../src/browser.mjs';

const cfg = loadConfig();
const id = process.argv[2] || cfg.profiles[0].id;
const profile = cfg.profiles.find((p) => p.id === id);
try {
  const browser = await connect({ profile });
  const page = await browser.newWindow('https://studio.youtube.com/');
  const where = await page.waitFor(
    () => {
      const m = location.href.match(/\/channel\/(UC[\w-]{22})/);
      if (m) return { channelId: m[1] };
      if (/create_channel|channel_creation|\/create/.test(location.href) || document.querySelector('ytd-channel-creation-dialog-renderer'))
        return { channelId: null, note: '채널이 아직 없음(채널 만들기 화면)' };
      return null;
    },
    { timeout: 25000, what: '스튜디오 채널 주소' },
  );
  if (!where.channelId) {
    console.log(JSON.stringify({ profile: profile.name, ...where }));
  } else {
    await page.goto(`https://studio.youtube.com/channel/${where.channelId}/videos/upload?hl=ko`);
    const list = await page
      .waitFor(
        () => {
          const rows = [...document.querySelectorAll('ytcp-video-row')];
          const empty = document.querySelector('ytcp-video-section-content #empty-state, .ytcp-video-section-content-empty, ytcp-warm-welcome-content');
          if (!rows.length && !empty) return null;
          return rows.slice(0, 20).map((r) => {
            const a = r.querySelector('a#thumbnail-anchor, a[href*="/video/"]');
            const vid = (a?.getAttribute('href') || '').match(/\/video\/([\w-]{11})/)?.[1] || null;
            return {
              videoId: vid,
              title: r.querySelector('#video-title')?.textContent.trim() || null,
              visibility: r.querySelector('.visibility, #visibility-text, .tablecell-visibility')?.textContent.trim().replace(/\s+/g, ' ') || null,
            };
          });
        },
        { timeout: 25000, what: '내 영상 목록' },
      )
      .catch((e) => ({ error: e.message }));
    console.log(JSON.stringify({ profile: profile.name, channelId: where.channelId, videos: list }));
  }
} catch (e) {
  console.error('실패:', e.message);
  process.exitCode = 1;
} finally {
  await closeAll();
}
