// Decode PNGs in a headless page and print luminance statistics. Judging
// "too dark" by eye across two screenshots is guesswork; a histogram is not.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setContent('<canvas id=c></canvas>');
for (const f of files) {
  const b64 = 'data:image/png;base64,' + readFileSync(f).toString('base64');
  const s = await p.evaluate(async (src) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = src; });
    const c = document.getElementById('c');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    // Skip the top 18% and bottom 8%: that is HUD, not rendered scene.
    const y0 = Math.floor(img.height * 0.18), y1 = Math.floor(img.height * 0.92);
    const d = x.getImageData(0, y0, img.width, y1 - y0).data;
    let sum = 0, n = 0, dark = 0, bright = 0;
    const hist = new Array(10).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      sum += l; n++;
      if (l < 0.04) dark++;
      if (l > 0.92) bright++;
      hist[Math.min(9, Math.floor(l * 10))]++;
    }
    return {
      meanLuma: +(sum / n).toFixed(4),
      pctNearBlack: +(100 * dark / n).toFixed(1),
      pctClipped: +(100 * bright / n).toFixed(2),
      histogram: hist.map((h) => +(100 * h / n).toFixed(1))
    };
  }, b64);
  console.log(f.padEnd(24), JSON.stringify(s));
}
await b.close();
