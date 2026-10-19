// 크롬 전용 프로필 조종 부품 — Playwright(launchPersistentContext) + 설치된 Google Chrome.
// cdp.mjs 와 같은 모양(connect → newWindow/newBackgroundWindow/disconnect, page 메서드)이라
// 수집·게시 코드는 이 파일만 바꿔 끼우면 된다.
// 프로필 하나당 크롬 하나를 띄워 서버가 살아 있는 동안 재사용한다(같은 폴더는 동시에 하나만 열 수 있다).
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** 설치된 Google Chrome 실행 파일 경로. CHROME_PATH 환경변수가 있으면 그것. */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Google Chrome 을 찾지 못했습니다. CHROME_PATH 환경변수로 chrome 실행 파일 경로를 알려 주세요.');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contexts = new Map(); // profileId → { mode, promise: Promise<BrowserContext> }

// 여는 방식 — show: 보이는 창(게시·시연) · offscreen: 진짜 크롬이지만 창을 모니터 밖에(수집) · headless: 창 없음
// 자막을 읽으려면 수집은 offscreen + hideAutomation(아래 chromeArgs) — 헤드리스는 옵션을 넣어도 자막 본문이 비었다(2026-10-19 실측).
export const MODES = ['show', 'offscreen', 'headless'];
function launchOptions(mode) {
  const common = ['--lang=ko-KR', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'];
  // 끄기 신호는 서버가 직접 처리한다(Playwright 가 가로채면 종료 코드가 130 이 된다)
  const base = {
    channel: 'chrome', locale: 'ko-KR', handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (mode === 'show') return { ...base, headless: false, viewport: null, args: [...common, '--start-maximized'] };
  if (mode === 'offscreen') return { ...base, headless: false, viewport: { width: 1280, height: 900 }, args: [...common, '--window-position=-32000,-32000', '--window-size=1280,900'] };
  return { ...base, headless: true, viewport: { width: 1280, height: 900 }, args: common };
}
/** 환경변수 JG_BROWSER_MODE 가 있으면 모든 연결이 그 방식(시험용 — 예: headless). */
export function pickMode(wanted) {
  const forced = process.env.JG_BROWSER_MODE;
  if (forced && MODES.includes(forced)) return forced;
  return MODES.includes(wanted) ? wanted : 'show';
}

export function resolveUserDataDir(profile) {
  const dir = profile.userDataDir.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
  if (/%[^%]+%/.test(dir)) throw new Error(`프로필 폴더 경로의 환경변수를 풀지 못했습니다: ${profile.userDataDir}`);
  return dir;
}

const LOCK_RETRY = { tries: 10, gapMs: 500 }; // 막 닫은 프로필의 잠금이 풀리길 기다리는 횟수·간격(정한 값)
const PORT_WAIT = { tries: 150, gapMs: 100 }; // 크롬이 조종 통로 번호를 적을 때까지 최대 15초(정한 값)
const isLockError = (e) => /ProcessSingleton|user data directory is already in use|Opening in existing browser session/i.test(e?.message || '');

// 크롬 여는 전략 — attach(기본): 사람이 띄우듯 크롬을 실행하고 Playwright 가 조종 통로로 붙는다.
//   실행 인자를 이 파일이 다 정하므로(자동 조종 표시 끄기 등) 프로필마다 다르게 띄울 수 있다.
// launch: Playwright launchPersistentContext. JG_BROWSER_STRATEGY=launch 로 고른다.
const STRATEGY = process.env.JG_BROWSER_STRATEGY === 'launch' ? 'launch' : 'attach';

// hideAutomation — 읽기 전용 프로필(config.collector.hideAutomationFlag)에만 쓴다(사용자 결정 2026-10-19).
//   Chrome 155 는 조종 통로를 열면 navigator.webdriver 를 켜고, 유튜브는 그때 무효 확인값(pot)을 만들어 자막 본문을 비운다(실측:
//   켬 120자 pot → 0자 · 끔 116자 pot → 본편 493,243자). 게시용 프로필에는 쓰지 않는다 — 스팸 차단 우회가 되지 않게.
function chromeArgs(userDataDir, mode, { hideAutomation = false } = {}) {
  const a = [
    `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--lang=ko-KR', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
  ];
  if (hideAutomation) a.push('--disable-blink-features=AutomationControlled');
  // 보이는 창은 주 모니터(0,0)에서 최대화 — 크롬은 마지막 창 위치를 기억해 보조 모니터에 뜰 수 있다(녹화에 안 잡힘, 실측)
  if (mode === 'show') a.push(`--window-position=${process.env.JG_WIN_POS || '0,0'}`, '--start-maximized');
  else if (mode === 'offscreen') a.push('--window-position=-32000,-32000', `--window-size=${process.env.JG_OFFSCREEN_SIZE || '1280,900'}`);
  else a.push('--headless=new', '--window-size=1280,900');
  a.push('about:blank');
  return a;
}

const debug = (...a) => { if (process.env.JG_DEBUG === '1') console.error(`[browser ${new Date().toISOString().slice(11, 23)}]`, ...a); };

async function attachSpawned(userDataDir, mode, opts = {}) {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  try { rmSync(portFile, { force: true }); } catch (e) { debug('포트 파일 지우기 실패', e.code); }
  const spawnedAt = Date.now() - 1000; // 파일 시각 오차 여유 1초
  const child = spawn(findChrome(), chromeArgs(userDataDir, mode, opts), { stdio: 'ignore' });
  debug('크롬 실행', mode, 'pid', child.pid);
  let exited = false;
  child.on('exit', (code) => { exited = true; debug('크롬 종료', code); });
  let port = null;
  for (let i = 0; i < PORT_WAIT.tries && !port; i++) {
    // 앞 크롬이 남긴 파일(못 지운 경우)을 새 크롬 것으로 착각하지 않게 — 새로 쓰인 파일만 읽는다
    if (existsSync(portFile) && statSync(portFile).mtimeMs >= spawnedAt) port = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim() || null;
    if (!port) {
      if (exited) break;
      await sleep(PORT_WAIT.gapMs);
    }
  }
  if (!port) {
    try { child.kill(); } catch {}
    // 같은 프로필 크롬이 이미 떠 있으면 새 크롬은 기존 창에 넘기고 바로 끝난다
    throw new Error(exited ? 'user data directory is already in use (크롬이 바로 종료됨)' : '크롬 조종 통로가 열리지 않았습니다');
  }
  debug('조종 통로', port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  debug('붙음 · 탭', ctx.pages().length);
  browser.on('disconnected', () => { ctx._closedByUser = true; });
  ctx._jgClose = async () => {
    try { const s = await browser.newBrowserCDPSession(); await s.send('Browser.close'); } catch {}
    try { await browser.close(); } catch {}
    if (!exited) await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
    if (!exited) try { child.kill(); } catch {}
  };
  return ctx;
}
const closeCtx = (ctx) => (ctx._jgClose ? ctx._jgClose() : ctx.close());

async function getContext(profile, mode) {
  const cached = contexts.get(profile.id);
  if (cached) {
    const ctx = await cached.promise.catch(() => null);
    const alive = ctx && !ctx._closedByUser;
    debug('기존 크롬', cached.mode, '→', mode, alive ? '살아 있음' : '닫힘');
    if (alive && cached.mode === mode) return ctx;
    contexts.delete(profile.id);
    if (alive) await closeCtx(ctx).catch(() => {}); // 방식이 바뀌면 닫고 새로 연다
  }
  const userDataDir = resolveUserDataDir(profile);
  mkdirSync(userDataDir, { recursive: true });
  const launchOnce = () =>
    STRATEGY === 'attach'
      ? attachSpawned(userDataDir, mode, { hideAutomation: profile.hideAutomationFlag === true })
      : chromium.launchPersistentContext(userDataDir, launchOptions(mode));
  const launching = (async () => {
    for (let i = 1; ; i++) {
      try {
        return await launchOnce();
      } catch (e) {
        if (!isLockError(e) || i >= LOCK_RETRY.tries) throw e;
        await sleep(LOCK_RETRY.gapMs);
      }
    }
  })()
    .then((ctx) => {
      ctx.on('close', () => {
        ctx._closedByUser = true;
        if (contexts.get(profile.id)?.promise === launching) contexts.delete(profile.id);
      });
      return ctx;
    })
    .catch((e) => {
      if (contexts.get(profile.id)?.promise === launching) contexts.delete(profile.id);
      if (isLockError(e)) {
        throw new Error(`'${profile.name}' 크롬 프로필이 이미 다른 창에서 열려 있습니다. 그 크롬 창을 닫고 다시 시도하세요.`);
      }
      throw new Error(`'${profile.name}' 크롬 프로필을 열지 못했습니다: ${e.message.split('\n')[0]}`);
    });
  contexts.set(profile.id, { mode, promise: launching });
  return launching;
}

/** cdp.mjs 의 connect 와 같은 모양. profile 은 config.profiles 의 한 항목. mode 는 MODES 중 하나(기본 show). */
export async function connect({ profile, mode } = {}) {
  if (!profile) throw new Error('connect: profile 이 필요합니다');
  const ctx = await getContext(profile, pickMode(mode ?? 'show'));
  const opened = new Set();

  async function open(url) {
    // 프로필을 처음 열 때 생기는 빈 탭이 있으면 그것을 쓴다.
    const blank = ctx.pages().find((p) => p.url() === 'about:blank' && !p._jgOwned);
    const pw = blank || (await ctx.newPage());
    pw._jgOwned = true;
    const page = makePage(ctx, pw, opened);
    opened.add(page);
    if (url) await page.goto(url);
    return page;
  }

  const showMode = pickMode(mode ?? 'show') === 'show';
  return {
    newWindow: async (url) => {
      const page = await open(url);
      if (showMode) {
        // 창을 최대화 상태로 확실히 만든다(--start-maximized 가 안 먹는 경우가 있었다)
        try {
          const { windowId } = await page.send('Browser.getWindowForTarget');
          await page.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await page.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0 } });
          await page.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        } catch (e) { debug('창 최대화 실패', e.message); }
      }
      await page.bringToFront();
      return page;
    },
    newBackgroundWindow: (url) => open(url),
    async disconnect({ keepOpen = [] } = {}) {
      for (const page of opened) {
        if (keepOpen.includes(page.targetId)) continue;
        await page.close().catch(() => {});
      }
      opened.clear();
    },
  };
}

/** 서버를 끌 때 열어 둔 크롬을 모두 닫는다. */
export async function closeAll() {
  const all = [...contexts.values()];
  contexts.clear();
  for (const { promise } of all) {
    const ctx = await promise.catch(() => null);
    if (ctx) await closeCtx(ctx).catch(() => {});
  }
}

let seq = 0;
function makePage(ctx, pw, opened) {
  let cdp = null;
  const getCdp = async () => (cdp ||= await ctx.newCDPSession(pw));
  const page = {
    targetId: `pw-${++seq}`,
    raw: pw,

    async send(method, params = {}) {
      return (await getCdp()).send(method, params);
    },
    async onCdp(event, fn) {
      (await getCdp()).on(event, fn);
    },

    async evaluate(fn, ...args) {
      const expression = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn;
      try {
        return await pw.evaluate(expression);
      } catch (e) {
        throw new Error(`페이지 스크립트 오류: ${e.message.split('\n')[0]}`);
      }
    },

    async waitFor(fn, { timeout = 15000, interval = 250, args = [], what = '조건' } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          const v = await page.evaluate(fn, ...args);
          if (v) return v;
        } catch {}
        await sleep(interval);
      }
      throw new Error(`시간 초과: ${what} (${timeout}ms)`);
    },

    async goto(url, { timeout = 30000 } = {}) {
      await pw.goto(url, { waitUntil: 'load', timeout }).catch((e) => {
        if (!/Timeout/i.test(e.message)) throw e;
      });
    },

    async bringToFront() {
      await pw.bringToFront();
    },

    async click(selector, { timeout = 15000 } = {}) {
      const box = await page.waitFor(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        { timeout, args: [selector], what: `요소 ${selector}` },
      );
      await sleep(150);
      await pw.mouse.click(box.x, box.y);
      return box;
    },

    async typeText(text, { delayMs = 90, onChar } = {}) {
      const chars = Array.from(text);
      for (let i = 0; i < chars.length; i++) {
        await pw.keyboard.insertText(chars[i]);
        onChar?.(i + 1, chars.length);
        await sleep(delayMs);
      }
    },

    async screenshot(path) {
      await pw.screenshot({ path });
      return path;
    },

    async close() {
      opened.delete(page);
      if (!pw.isClosed()) await pw.close();
    },
  };
  return page;
}
