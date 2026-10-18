// Frame-by-frame renderer with injected fake clock (no CDP virtual time)
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FPS = +process.env.FPS || 30;
const DURATION = +process.env.DURATION || 10; // seconds
const WIDTH = +process.env.WIDTH || 1080;
const HEIGHT = +process.env.HEIGHT || 1920;
const MODE = process.env.MODE || 'test'; // test | full

const OUT = path.resolve('out');
const FRAMES = path.resolve('frames');
for (const d of [OUT, FRAMES]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

// Ye script page ke har JS se pehle chalti hai: browser ki clock band karke
// hum khud time aage badhate hain.
function installFakeClock() {
  let now = 0;
  let id = 1;
  const base = Date.now();
  const timers = new Map();
  let rafs = [];

  Date.now = () => base + now;
  performance.now = () => now;

  window.requestAnimationFrame = (cb) => { const i = id++; rafs.push({ i, cb }); return i; };
  window.cancelAnimationFrame = (i) => { rafs = rafs.filter((r) => r.i !== i); };
  window.setTimeout = (fn, ms = 0, ...a) => {
    const i = id++;
    timers.set(i, { fn: () => fn(...a), at: now + Math.max(0, +ms || 0), every: 0 });
    return i;
  };
  window.setInterval = (fn, ms = 0, ...a) => {
    const i = id++;
    const every = Math.max(1, +ms || 1);
    timers.set(i, { fn: () => fn(...a), at: now + every, every });
    return i;
  };
  window.clearTimeout = window.clearInterval = (i) => { timers.delete(i); };

  function syncAnimations(prev) {
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      if (a.__t0 === undefined) a.__t0 = prev;
      try { a.pause(); a.currentTime = now - a.__t0; } catch (e) {}
    }
  }

  window.__advance = (ms) => {
    const prev = now;
    const target = now + ms;
    for (;;) {
      let nextId = null, nextAt = Infinity;
      for (const [i, t] of timers) if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = i; }
      if (nextId === null) break;
      const t = timers.get(nextId);
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(nextId);
      try { t.fn(); } catch (e) { console.error(e); }
    }
    now = target;
    const list = rafs; rafs = [];
    for (const r of list) { try { r.cb(now); } catch (e) { console.error(e); } }
    syncAnimations(prev);
  };
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

  // 1) Clock pehle band: page load se pehle inject
  await page.evaluateOnNewDocument(installFakeClock);

  await page.goto('file://' + path.resolve('index.html'), { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.evaluate(() => window.__advance(0)); // animations ko t=0 pe set karo

  const hasHook = await page.evaluate(() => typeof window.renderFrame === 'function');
  const step = 1000 / FPS;
  let cur = 0;

  async function seek(ms) {
    while (cur < ms - 1e-6) {
      const d = Math.min(step, ms - cur);
      await page.evaluate((x) => window.__advance(x), d);
      cur += d;
    }
    if (hasHook) await page.evaluate((t) => window.renderFrame(t), cur / 1000);
  }
  const shot = (file) => page.screenshot({ path: file, type: 'png' });
  const totalFrames = Math.round(DURATION * FPS);

  if (MODE === 'test') {
    const points = [0, DURATION * 500, Math.max(0, DURATION * 1000 - step)];
    for (let i = 0; i < points.length; i++) {
      await seek(points[i]);
      await shot(path.join(OUT, `test_${i + 1}_${(points[i] / 1000).toFixed(1)}s.png`));
      console.log('test frame', i + 1, 'at', points[i] / 1000, 's');
    }
    await browser.close();
    console.log('Test frames done.');
    return;
  }

  for (let i = 0; i < totalFrames; i++) {
    await seek(i * step);
    await shot(path.join(FRAMES, String(i + 1).padStart(6, '0') + '.png'));
    if (i % 60 === 0) console.log(`frame ${i + 1}/${totalFrames}`);
  }
  await browser.close();

  const hasAudio = fs.existsSync('audio.mp3');
  const audioArgs = hasAudio ? '-i audio.mp3 -c:a aac -shortest' : '';
  execSync(
    `ffmpeg -y -framerate ${FPS} -i frames/%06d.png ${audioArgs} -c:v libx264 -pix_fmt yuv420p -crf 18 out/video.mp4`,
    { stdio: 'inherit' }
  );
  console.log('Done: out/video.mp4');
})().catch((e) => { console.error(e); process.exit(1); });
