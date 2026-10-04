// Phase 1 step 5: full-page screenshots per route x language x viewport (portrait + landscape).
import path from 'node:path';
import { AUDIT, RTL_LANGS, ensureDir, writeJson, routeSlug, loadRoutes, launch, newContext, pool } from './lib.mjs';

// Mobile-first matrix (widths from requirements). Landscape = swapped dims for handheld sizes.
const VIEWPORTS = [
  { name: '360', width: 360, height: 800, mobile: true },
  { name: '375', width: 375, height: 812, mobile: true },
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '414', width: 414, height: 896, mobile: true },
  { name: '768', width: 768, height: 1024, mobile: true },
  { name: '1024', width: 1024, height: 1366, mobile: true },
  { name: '1440', width: 1440, height: 900, mobile: false },
];
const ORIENT = (process.env.SHOT_ORIENTATIONS || 'portrait,landscape').split(',');
const ONLY = process.env.SHOT_WIDTHS?.split(',');

const { pages } = loadRoutes();
const uniq = [...new Map(pages.filter((p) => !p.error && p.status < 400).map((p) => [p.finalUrl, p])).values()];
const OUT = ensureDir(path.join(AUDIT, 'screenshots'));
const browser = await launch();
const index = [];

for (const vp of VIEWPORTS.filter((v) => !ONLY || ONLY.includes(v.name))) {
  for (const o of ORIENT) {
    if (o === 'landscape' && !vp.mobile) continue;
    const [w, h] = o === 'landscape' ? [vp.height, vp.width] : [vp.width, vp.height];
    const ctx = await newContext(browser, { viewport: { width: w, height: h }, isMobile: vp.mobile && w < 1024, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 });
    await pool(uniq, 3, async (p) => {
      const page = await ctx.newPage();
      const file = path.join(OUT, p.language, `${vp.name}-${o}`, routeSlug(p.finalUrl) + '.png');
      ensureDir(path.dirname(file));
      try {
        await page.goto(p.finalUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => page.waitForLoadState('load'));
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); } window.scrollTo(0, 0); });
        await page.waitForTimeout(1000);
        const dir = await page.evaluate(() => getComputedStyle(document.documentElement).direction);
        const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
        index.push({ url: p.finalUrl, language: p.language, viewport: vp.name, orientation: o, width: w, height: h, dir, expectedRtl: RTL_LANGS.has(p.language), horizontalOverflow: overflowX, file: path.relative(path.dirname(AUDIT), file) });
      } catch (e) { index.push({ url: p.finalUrl, language: p.language, viewport: vp.name, orientation: o, error: String(e.message).slice(0, 200) }); }
      await page.close();
    });
    await ctx.close();
    console.log(`[screenshots] ${vp.name} ${o} done`);
  }
}
await browser.close();
writeJson(path.join(OUT, 'index.json'), index);
const rtlMismatch = index.filter((i) => i.expectedRtl && i.dir !== 'rtl').length;
console.log(`[screenshots] ${index.length} shots; ${index.filter((i) => i.horizontalOverflow).length} with horizontal overflow; ${rtlMismatch} RTL-language shots not rendered RTL`);
