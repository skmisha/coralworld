// Phase 1 step 7: open the site's chat widget in each language, ask the 15 questions, log transcripts.
// Vendor-agnostic: tries known launcher selectors, then heuristics, inside the page and inside iframes.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT, BASE, ensureDir, readJson, loadRoutes, launch, newContext } from './lib.mjs';

const Q = readJson(path.join(import.meta.dirname, 'chat-questions.json'));
const OUT = ensureDir(path.join(AUDIT, 'chat'));
const REPLY_TIMEOUT = Number(process.env.CHAT_REPLY_TIMEOUT || 45000);
const { pages, languages } = loadRoutes();

// Home page per language
const homes = {};
for (const l of languages) {
  const cands = pages.filter((p) => p.language === l && !p.error && p.status < 400).sort((a, b) => new URL(a.finalUrl).pathname.length - new URL(b.finalUrl).pathname.length);
  if (cands[0]) homes[l] = cands[0].finalUrl;
}
if (!Object.keys(homes).length) homes.und = BASE;

const LAUNCHERS = [
  '#glassix-widget-launcher-container', '[id^=glassix] button', '.glassix-widget-launcher',
  'iframe[title*="chat" i]', '#launcher', '[data-testid=launcher]', '.intercom-launcher', '#tawkchat-container',
  '#chat-widget-container', '.tidio-chat', '#tidio-chat', '.crisp-client .cc-unoo', '#fc_frame',
  '#hubspot-messages-iframe-container', '.bp-widget-widget', '#voiceflow-chat', '#chatbase-bubble-button',
  '[aria-label*="chat" i]', '[title*="chat" i]', '[class*="chat" i][class*="launcher" i]', '[class*="chat" i][class*="button" i]',
  '[id*="chat" i] button', '[aria-label*="צ\'אט"]', '[aria-label*="צאט"]', '[aria-label*="שיחה"]',
];
const INPUTS = ['textarea', 'input[type=text]', '[contenteditable=true]', 'input:not([type])'];

async function findInFrames(page, selectors, visibleOnly = true) {
  for (const f of page.frames()) for (const s of selectors) {
    const loc = f.locator(s).first();
    if (await loc.count().catch(() => 0)) { if (!visibleOnly || await loc.isVisible().catch(() => false)) return { frame: f, loc, selector: s }; }
  }
  return null;
}

async function snapshotText(frame) {
  return frame.evaluate(() => document.body.innerText).catch(() => '');
}

const summary = [];
const browser = await launch();
for (const [lang, url] of Object.entries(homes)) {
  const qs = Q[lang] || Q.en;
  const md = [`# Chat transcript — ${lang}`, '', `- Page: ${url}`, `- Run: ${new Date().toISOString()}`, `- Questions: ${Q[lang] ? lang : 'en (no translation for ' + lang + ')'}`, ''];
  const ctx = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: lang === 'und' ? 'he-IL' : lang });
  const page = await ctx.newPage();
  const shotDir = ensureDir(path.join(OUT, 'shots', lang));
  let status = 'ok';
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000); // widgets often load late
    // dismiss cookie banners that block the launcher
    for (const t of ['Accept', 'אישור', 'מאשר', 'אני מסכים', 'Принять', 'قبول', 'OK']) {
      const b = page.getByRole('button', { name: new RegExp(t, 'i') }).first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
    }
    const launcher = await findInFrames(page, LAUNCHERS);
    if (!launcher) throw new Error('No chat launcher found (check audit/integrations.md for a chat vendor; may need a custom selector)');
    md.push(`- Launcher: \`${launcher.selector}\` in frame \`${launcher.frame.url().slice(0, 100)}\``, '');
    await launcher.loc.click({ timeout: 10000 }).catch(async () => launcher.loc.dispatchEvent('click'));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(shotDir, '00-open.png') });
    // greeting
    const input0 = await findInFrames(page, INPUTS);
    if (!input0) throw new Error('Chat opened but no text input found (may be WhatsApp redirect or menu-only bot)');
    const greeting = await snapshotText(input0.frame);
    md.push('## Greeting / initial state', '', '```', greeting.slice(-1500).trim(), '```', '');

    for (let i = 0; i < qs.length; i++) {
      const input = await findInFrames(page, INPUTS);
      if (!input) { md.push(`## Q${i + 1} (${Q.ids[i]})`, '', '_Input disappeared (handoff/form?)_', ''); status = 'partial'; break; }
      const before = await snapshotText(input.frame);
      const t0 = Date.now();
      await input.loc.click(); await input.loc.fill(qs[i]).catch(() => input.loc.type(qs[i]));
      await input.loc.press('Enter');
      // wait until transcript text grows and then stabilises for 4s
      let last = before, stableSince = Date.now(), grew = false;
      while (Date.now() - t0 < REPLY_TIMEOUT) {
        await page.waitForTimeout(1000);
        const now = await snapshotText(input.frame);
        if (now !== last) { last = now; stableSince = Date.now(); if (now.length > before.length + qs[i].length + 5) grew = true; }
        else if (grew && Date.now() - stableSince > 4000) break;
      }
      const delta = last.startsWith(before) ? last.slice(before.length) : last.slice(-2000);
      const reply = delta.replace(qs[i], '').trim();
      md.push(`## Q${i + 1} (${Q.ids[i]})`, '', `**User:** ${qs[i]}`, '', `**Bot** (${((Date.now() - t0) / 1000).toFixed(1)}s${grew ? '' : ', no reply detected'}):`, '', '```', reply.slice(0, 3000) || '(empty)', '```', '');
      await page.screenshot({ path: path.join(shotDir, `${String(i + 1).padStart(2, '0')}-${Q.ids[i]}.png`) });
    }
  } catch (e) { status = 'failed'; md.push(`**Run failed:** ${e.message}`, ''); await page.screenshot({ path: path.join(shotDir, 'failure.png') }).catch(() => {}); }
  md.push('## Analyst notes (fill in manually)', '', '- Tone:', '- Answered correctly / deflected / wrong:', '- Language handling (replied in same language?):', '- Human handoff offered? How:', '- Links to booking flow?', '- Limits observed:', '');
  fs.writeFileSync(path.join(OUT, `${lang}.md`), md.join('\n'));
  summary.push({ lang, url, status });
  await ctx.close();
  console.log(`[chat] ${lang}: ${status}`);
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'README.md'), `# Chat audit\n\n| Language | Page | Status |\n|---|---|---|\n${summary.map((s) => `| ${s.lang} | ${s.url} | ${s.status} |`).join('\n')}\n\nCross-language summary of tone, capabilities, language handling, handoff and limits is written manually into audit/chat/SUMMARY.md after reviewing transcripts.\n`);
