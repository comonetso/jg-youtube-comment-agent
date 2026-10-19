// 전용 크롬 프로필이 유튜브에 로그인돼 있는지 확인한다. 읽기만 한다.
// 사용: node tools/check-login.mjs [profileId]
import { loadConfig } from '../src/config.mjs';
import { connect, closeAll } from '../src/browser.mjs';

const cfg = loadConfig();
const id = process.argv[2] || cfg.profiles[0].id;
const profile = cfg.profiles.find((p) => p.id === id);
try {
  const browser = await connect({ profile });
  const page = await browser.newWindow('https://www.youtube.com/?hl=ko');
  const state = await page.waitFor(
    () => {
      const cfg = window.ytcfg?.data_ || {};
      if (cfg.LOGGED_IN === undefined) return null;
      const avatar = document.querySelector('#avatar-btn img, button#avatar-btn img');
      return {
        loggedIn: cfg.LOGGED_IN === true,
        hl: cfg.HL,
        avatarAlt: avatar?.getAttribute('alt') || null,
        hasSignInButton: !!document.querySelector('a[href*="ServiceLogin"]'),
      };
    },
    { timeout: 20000, what: '유튜브 로그인 정보' },
  );
  console.log(JSON.stringify({ profile: profile.name, ...state }));
} catch (e) {
  console.error('실패:', e.message);
  process.exitCode = 1;
} finally {
  await closeAll();
}
