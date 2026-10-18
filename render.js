// Frame-by-frame renderer: browser clock pause -> frames -> ffmpeg mp4
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

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();

  // 1) Browser clock PAUSE pehle, page load se pehle
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

  const advance = (ms) => new Promise((resolve) => {
    if (ms <= 0) return resolve();
    client.once('Emulation.virtualTimeBudgetExpired', resolve);
    client.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: ms });
  });

  await page.goto('file://' + path.resolve('index.html'), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts && document.fonts.ready);

  // Optional hook: agar page mein window.renderFrame(t) ho to wo use hoga
  const hasHook = await page.evaluate(() => typeof window.renderFrame === 'function');

  let current = 0; // ms
  async function seek(ms) {
    if (hasHook) {
      await page.evaluate((t) => window.renderFrame(t), ms / 1000);
    } else {
      await advance(ms - current);
    }
    current = ms;
  }
  const shot = (file) => page.screenshot({ path: file, type: 'png' });

  const totalFrames = Math.round(DURATION * FPS);

  if (MODE === 'test') {
    // 3 test frames: start, beech, end ke qareeb
    const points = [0, DURATION * 500, Math.max(0, DURATION * 1000 - 1000 / FPS)];
    for (let i = 0; i < points.length; i++) {
      await seek(points[i]);
      await shot(path.join(OUT, `test_${i + 1}_${(points[i] / 1000).toFixed(1)}s.png`));
      console.log('test frame', i + 1, 'at', points[i] / 1000, 's');
    }
    await browser.close();
    console.log('Test frames done. Artifact "test-frames" check karo.');
    return;
  }

  // FULL render
  for (let i = 0; i < totalFrames; i++) {
    await seek((i * 1000) / FPS);
    await shot(path.join(FRAMES, String(i + 1).padStart(6, '0') + '.png'));
    if (i % 60 === 0) console.log(`frame ${i + 1}/${totalFrames}`);
  }
  await browser.close();

  // Agar repo mein audio.mp3 hai to video mein lag jayega
  const hasAudio = fs.existsSync('audio.mp3');
  const audioArgs = hasAudio ? '-i audio.mp3 -c:a aac -shortest' : '';
  execSync(
    `ffmpeg -y -framerate ${FPS} -i frames/%06d.png ${audioArgs} -c:v libx264 -pix_fmt yuv420p -crf 18 out/video.mp4`,
    { stdio: 'inherit' }
  );
  console.log('Done: out/video.mp4');
})().catch((e) => { console.error(e); process.exit(1); });
