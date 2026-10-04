// Phase 1 step 8: axe-core (WCAG 2.0/2.1/2.2 A+AA) + Lighthouse (mobile & desktop) on every route,
// plus mobile checks: reflow at 320 CSS px (=1280px @400% / 640px @200%), touch target size, reduced motion.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { AUDIT, ensureDir, writeJson, routeSlug, loadRoutes, launch, newContext, pool } from './lib.mjs';

const OUT = ensureDir(path.join(AUDIT, 'a11y'));
const LH_FORMS = (process.env.LH_FORM_FACTORS || 'mobile,desktop').split(',');
const SKIP_LH = process.env.SKIP_LIGHTHOUSE === '1';
const { pages } = loadRoutes();
const uniq = [...new Map(pages.filter((p) => !p.error && p.status < 400).map((p) => [p.finalUrl, p])).values()];

// ---- axe + mobile checks ----
const browser = await launch();
const axeResults = [];
for (const [label, opts] of [['mobile', { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }], ['desktop', { viewport: { width: 1440, height: 900 } }]]) {
  const ctx = await newContext(browser, opts);
  await pool(uniq, 3, async (p) => {
    const page = await ctx.newPage();
    try {
      await page.goto(p.finalUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      let mobile = {};
      if (label === 'mobile') {
        mobile = await page.evaluate(() => {
          const small = [];
          for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [tabindex]:not([tabindex="-1"])')) {
            const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
            if (!b.width || !b.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
            if (el.closest('p, li') && el.tagName === 'A' && b.height >= 16) continue; // inline text links exempt (WCAG 2.5.8)
            if (b.width < 44 || b.height < 44) small.push({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40), w: Math.round(b.width), h: Math.round(b.height) });
          }
          const vp = document.querySelector('meta[name=viewport]')?.content || '';
          return { targetsUnder44: small.length, targetSamples: small.slice(0, 15), viewportMeta: vp, zoomBlocked: /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(vp), hasReducedMotionCSS: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.conditionText?.includes('prefers-reduced-motion')); } catch { return false; } }) };
        });
        await page.setViewportSize({ width: 320, height: 640 });
        await page.waitForTimeout(500);
        mobile.reflowOverflowAt320 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      }
      axeResults.push({ url: p.finalUrl, language: p.language, context: label, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags.filter((t) => t.startsWith('wcag')), help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })), incomplete: r.incomplete.length, passes: r.passes.length, mobile });
    } catch (e) { axeResults.push({ url: p.finalUrl, language: p.language, context: label, error: String(e.message).slice(0, 200) }); }
    await page.close();
  });
  await ctx.close();
}
await browser.close();
writeJson(path.join(OUT, 'axe.json'), axeResults);

// ---- Lighthouse ----
const lh = [];
if (!SKIP_LH) {
  const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new', '--no-sandbox'] });
  ensureDir(path.join(OUT, 'lighthouse'));
  // mobile on every route; desktop on one representative per template (LH_DESKTOP_ALL=1 for every route)
  const repsLH = new Set([...new Set(uniq.map((p) => p.template))].map((t) => uniq.filter((p) => p.template === t).sort((a, b) => (b.wordCount || 0) - (a.wordCount || 0))[0]?.finalUrl));
  for (const p of uniq) for (const ff of LH_FORMS) {
    if (ff === 'desktop' && process.env.LH_DESKTOP_ALL !== '1' && !repsLH.has(p.finalUrl)) continue;
    try {
      const config = ff === 'desktop' ? (await import('lighthouse/core/config/desktop-config.js')).default : undefined; // default = mobile, Moto G Power, slow 4G
      const r = await lighthouse(p.finalUrl, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] }, config);
      const a = r.lhr.audits; const c = r.lhr.categories;
      fs.writeFileSync(path.join(OUT, 'lighthouse', `${p.language}__${routeSlug(p.finalUrl)}__${ff}.json`), r.report);
      lh.push({ url: p.finalUrl, language: p.language, formFactor: ff, performance: c.performance?.score, accessibility: c.accessibility?.score, bestPractices: c['best-practices']?.score, seo: c.seo?.score, lcpMs: a['largest-contentful-paint']?.numericValue, cls: a['cumulative-layout-shift']?.numericValue, tbtMs: a['total-blocking-time']?.numericValue, fcpMs: a['first-contentful-paint']?.numericValue, transferKB: Math.round((a['total-byte-weight']?.numericValue || 0) / 1024) });
    } catch (e) { lh.push({ url: p.finalUrl, language: p.language, formFactor: ff, error: String(e.message).slice(0, 200) }); }
  }
  await chrome.kill();
}
writeJson(path.join(OUT, 'lighthouse.json'), lh);

// ---- Toolbar + statement detection ----
const integ = fs.existsSync(path.join(AUDIT, 'integrations.json')) ? JSON.parse(fs.readFileSync(path.join(AUDIT, 'integrations.json'))) : [];
const toolbars = integ.filter((i) => i.category === 'accessibility toolbar');
const statements = pages.filter((p) => /accessib|נגישות|доступн|إمكانية الوصول|الوصول/i.test(`${decodeURIComponent(p.finalUrl || '')} ${p.title || ''} ${(p.h1 || []).join(' ')}`));

// ---- summary.md ----
const ok = axeResults.filter((r) => !r.error);
const byRule = new Map();
for (const r of ok) for (const v of r.violations) { const e = byRule.get(v.id) || { id: v.id, impact: v.impact, help: v.help, tags: v.tags, pages: new Set(), nodes: 0 }; e.pages.add(r.url); e.nodes += v.nodes; byRule.set(v.id, e); }
const rank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const rules = [...byRule.values()].sort((a, b) => (rank[a.impact] ?? 9) - (rank[b.impact] ?? 9) || b.pages.size - a.pages.size);
const mob = ok.filter((r) => r.context === 'mobile');
const pct = (x) => (x == null ? '—' : Math.round(x * 100));
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
let md = `# Accessibility & performance baseline\n\n_Generated ${new Date().toISOString()} — ${uniq.length} unique pages. Target: IS 5568 (≈ WCAG 2.0 AA) minimum; aim WCAG 2.2 AA._\n\n`;
md += `## Summary\n\n- axe runs: ${ok.length} (${axeResults.length - ok.length} errored)\n- Distinct rules violated: ${rules.length} (critical ${rules.filter((r) => r.impact === 'critical').length}, serious ${rules.filter((r) => r.impact === 'serious').length})\n`;
md += `- Mobile: pages with zoom disabled: ${mob.filter((r) => r.mobile.zoomBlocked).length}; horizontal overflow at 320px (reflow, WCAG 1.4.10): ${mob.filter((r) => r.mobile.reflowOverflowAt320).length}; median touch targets <44px per page: ${med(mob.map((r) => r.mobile.targetsUnder44)) ?? '—'}; pages with prefers-reduced-motion CSS: ${mob.filter((r) => r.mobile.hasReducedMotionCSS).length}\n`;
for (const ff of LH_FORMS) { const s = lh.filter((x) => x.formFactor === ff && !x.error); if (s.length) md += `- Lighthouse ${ff} medians: perf ${pct(med(s.map((x) => x.performance)))}, a11y ${pct(med(s.map((x) => x.accessibility)))}, SEO ${pct(med(s.map((x) => x.seo)))}, LCP ${Math.round(med(s.map((x) => x.lcpMs)) || 0)}ms, CLS ${(med(s.map((x) => x.cls)) ?? 0).toFixed(3)}, TBT ${Math.round(med(s.map((x) => x.tbtMs)) || 0)}ms (INP proxy)\n`; }
md += `\n## Violations by rule\n\n| Rule | Impact | WCAG | Pages | Nodes | Description |\n|---|---|---|---|---|---|\n${rules.map((r) => `| ${r.id} | ${r.impact} | ${r.tags.join(' ')} | ${r.pages.size} | ${r.nodes} | ${r.help} |`).join('\n')}\n`;
md += `\n## Existing accessibility toolbar\n\n${toolbars.length ? toolbars.map((t) => `- **${t.vendor}** — ${t.how.join(', ')} on ${t.pages.length} pages`).join('\n') : '- None detected automatically — verify manually.'}\n\nNote: overlays do not by themselves satisfy IS 5568; the rebuild must be conformant without the toolbar.\n`;
md += `\n## Accessibility statement pages\n\n${statements.length ? statements.map((s) => `- [${s.language}] ${s.finalUrl} — "${s.title}" (content in content/${s.language}/)`).join('\n') : '- None found — legal requirement in Israel (Equal Rights for Persons with Disabilities Regulations 2013, §35).'}\n\nCheck statement for: coordinator name + contact, date of last audit, known limitations, physical accessibility of the venue.\n`;
md += `\n## Per-page (mobile)\n\n| URL | Lang | Violations | <44px targets | Reflow@320 | Zoom blocked |\n|---|---|---|---|---|---|\n${mob.map((r) => `| ${r.url} | ${r.language} | ${r.violations.length} | ${r.mobile.targetsUnder44} | ${r.mobile.reflowOverflowAt320 ? 'FAIL' : 'ok'} | ${r.mobile.zoomBlocked ? 'YES' : 'no'} |`).join('\n')}\n`;
fs.writeFileSync(path.join(OUT, 'summary.md'), md);
console.log(`[a11y] axe ${ok.length} runs, ${rules.length} rules violated; lighthouse ${lh.filter((x) => !x.error).length} runs`);
