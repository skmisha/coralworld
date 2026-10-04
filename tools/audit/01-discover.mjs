// Phase 1 steps 1, 2, 4 (+ raw data for 3 and 6):
// robots.txt + sitemaps -> Playwright BFS crawl -> routes.csv, crawl.json, content/{lang}/{route}.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import {
  BASE, AUDIT, CONTENT, MAX_PAGES, CONCURRENCY, DELAY_MS, UA, isInternal, normalizeUrl, NON_PAGE_EXT,
  ensureDir, writeJson, routeSlug, csvRow, launch, newContext, sleep, langAllowed, langOfUrl,
} from './lib.mjs';

ensureDir(AUDIT);
const log = (...a) => console.log('[discover]', ...a);

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) return { status: res.status, text: null };
  let buf = Buffer.from(await res.arrayBuffer());
  if (url.endsWith('.gz') || buf[0] === 0x1f) { try { buf = zlib.gunzipSync(buf); } catch {} }
  return { status: res.status, text: buf.toString('utf8') };
}

// ---------- robots + sitemaps ----------
const robots = await fetchText(new URL('/robots.txt', BASE).toString());
fs.writeFileSync(path.join(AUDIT, 'robots.txt'), robots.text ?? `# HTTP ${robots.status}\n`);
const sitemapQueue = new Set([new URL('/sitemap.xml', BASE).toString(), new URL('/sitemap_index.xml', BASE).toString()]);
for (const m of (robots.text || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) sitemapQueue.add(m[1].trim());
const disallow = [...(robots.text || '').matchAll(/^\s*disallow:\s*(\S*)/gim)].map((m) => m[1]).filter(Boolean);

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const sitemapUrls = new Map(); // url -> { sitemap, alternates: [{hreflang, href}] }
const sitemapsSeen = [];
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
for (const sm of sitemapQueue) {
  if (sitemapsSeen.find((s) => s.url === sm)) continue;
  const { status, text } = await fetchText(sm).catch(() => ({ status: 0, text: null }));
  sitemapsSeen.push({ url: sm, status });
  if (!text || !text.includes('<')) continue;
  fs.writeFileSync(path.join(ensureDir(path.join(AUDIT, 'sitemaps')), routeSlug(sm) + '.xml'), text);
  const doc = xml.parse(text);
  for (const s of arr(doc.sitemapindex?.sitemap)) if (s.loc) sitemapQueue.add(String(s.loc).trim());
  for (const u of arr(doc.urlset?.url)) {
    const loc = normalizeUrl(String(u.loc).trim()); if (!loc) continue;
    const alternates = arr(u.link).map((l) => ({ hreflang: l['@_hreflang'], href: l['@_href'] })).filter((l) => l.href);
    sitemapUrls.set(loc, { sitemap: sm, alternates, lastmod: u.lastmod ?? null });
    for (const a of alternates) { const n = normalizeUrl(a.href); if (n && !sitemapUrls.has(n)) sitemapUrls.set(n, { sitemap: sm, alternates: [], viaAlternate: loc }); }
  }
}
writeJson(path.join(AUDIT, 'sitemaps.json'), { robots: { status: robots.status, disallow }, sitemaps: sitemapsSeen, urls: Object.fromEntries(sitemapUrls) });
log(`sitemaps: ${sitemapsSeen.filter((s) => s.status === 200).length} ok, ${sitemapUrls.size} URLs`);

// ---------- in-page extraction (runs in browser) ----------
function extractInPage() {
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const main = document.querySelector('main, [role=main], #main, #content, .site-content, article') || document.body;

  // Ordered content blocks from main
  const blocks = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT);
  const seen = new Set();
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    if (el.closest('nav, header, footer, script, style, noscript, [aria-hidden=true]') && el !== main) continue;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) blocks.push({ type: 'heading', level: +tag[1], text: txt(el) });
    else if (tag === 'p' && txt(el)) blocks.push({ type: 'paragraph', text: txt(el), html: el.innerHTML.trim() });
    else if ((tag === 'ul' || tag === 'ol') && !el.closest('li')) blocks.push({ type: 'list', ordered: tag === 'ol', items: [...el.children].map(txt).filter(Boolean) });
    else if (tag === 'table') blocks.push({ type: 'table', rows: [...el.rows].map((r) => [...r.cells].map(txt)) });
    else if (tag === 'img' && !seen.has(el.currentSrc || el.src)) { seen.add(el.currentSrc || el.src); blocks.push({ type: 'image', src: abs(el.currentSrc || el.src), alt: el.getAttribute('alt'), width: el.naturalWidth, height: el.naturalHeight }); }
    else if (tag === 'video') blocks.push({ type: 'video', src: abs(el.currentSrc || el.querySelector('source')?.src || ''), poster: abs(el.poster || '') });
    else if (tag === 'iframe') blocks.push({ type: 'iframe', src: abs(el.src), title: el.title || null });
    else if (tag === 'blockquote') blocks.push({ type: 'quote', text: txt(el) });
    else if ((tag === 'a' && /btn|button|cta/i.test(el.className)) || tag === 'button') { const t = txt(el); if (t) blocks.push({ type: 'cta', text: t, href: el.href || null }); }
  }

  const navLinks = (root) => root ? [...root.querySelectorAll('a[href]')].map((a) => ({ text: txt(a), href: abs(a.getAttribute('href')) })).filter((l) => l.href) : [];
  const forms = [...document.forms].map((f) => ({
    id: f.id || null, action: f.action ? abs(f.getAttribute('action') || '') : null, method: (f.method || 'get').toLowerCase(),
    fields: [...f.elements].filter((e) => e.name || e.id).map((e) => ({ tag: e.tagName.toLowerCase(), type: e.type || null, name: e.name || null, id: e.id || null, required: !!e.required, label: e.labels?.[0] ? txt(e.labels[0]) : (e.getAttribute('aria-label') || e.placeholder || null) })),
  }));

  // Language switcher: links whose hreflang/lang attr set, or common switcher containers
  const langLinks = [...document.querySelectorAll('a[hreflang], a[lang], .wpml-ls a, .lang-item a, [class*=lang] a, [class*=language] a, [id*=lang] a')]
    .map((a) => ({ text: txt(a), href: abs(a.getAttribute('href')), hreflang: a.getAttribute('hreflang') || a.getAttribute('lang') || null }))
    .filter((l) => l.href);

  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { return JSON.parse(s.textContent); } catch { return s.textContent; } });

  // Assets referenced anywhere in DOM (incl. CSS backgrounds)
  const assets = new Set();
  document.querySelectorAll('img').forEach((i) => { if (i.currentSrc || i.src) assets.add(abs(i.currentSrc || i.src)); (i.srcset || '').split(',').forEach((s) => { const u = s.trim().split(/\s+/)[0]; if (u) assets.add(abs(u)); }); const ds = i.getAttribute('data-src') || i.getAttribute('data-lazy-src'); if (ds) assets.add(abs(ds)); });
  document.querySelectorAll('source[src], source[srcset], video[src], video[poster], audio[src], a[href$=".pdf" i], link[rel*=icon]').forEach((e) => { ['src', 'poster', 'href'].forEach((k) => e.getAttribute(k) && assets.add(abs(e.getAttribute(k)))); (e.getAttribute('srcset') || '').split(',').forEach((s) => { const u = s.trim().split(/\s+/)[0]; if (u) assets.add(abs(u)); }); });
  document.querySelectorAll('*').forEach((e) => { const bg = getComputedStyle(e).backgroundImage; for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) assets.add(abs(m[1])); });

  const globals = Object.keys(window).filter((k) => /^(dataLayer|gtag|ga|fbq|_fbq|hj|_hjSettings|clarity|Intercom|zE|zESettings|\$zopim|Tawk_API|LiveChatWidget|__lc|tidioChatApi|drift|HubSpotConversations|_hsq|FB|twttr|grecaptcha|google|OneTrust|Optanon|Cookiebot|CookieYes|nagishli|enable_toolbar|userway|UserWay|accessibe|acsb|EqualWeb|INDmenu|ttq|snaptr|pintrk|_linkedin_partner_id|lintrk|_paq|mixpanel|amplitude|Elementor|elementorFrontend|wpml|icl_vars|woocommerce|wc_|Calendly|Wix|wixBiSession|smartlook|yandex|ym|criteo|taboola|_tfa|outbrain|obApi|botpress|voiceflow|ChatBot|webchat|glassix|activetrail|Smoove|Gleap|Crisp|\$crisp|Freshchat|fcWidget|Brevo|sib|klaviyo|_learnq|mailchimp|mc4wp|Trustpilot|trustindex|elfsight|eapps|instgrm|YT|Vimeo|wistia|_wq|hbspt|leadin|Salesforce|embedded_svc|zoho|\$zoho|Shopify|Stripe|PayPal|tranzila|cardcom|meshulam|grow|ticketsPlugin|smarticket|ticketim|eventer|Zappar)/i.test(k));

  return {
    url: location.href,
    lang: document.documentElement.lang || null,
    dir: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
    title: document.title,
    metaDescription: attr('meta[name=description]', 'content'),
    h1: [...document.querySelectorAll('h1')].map(txt),
    canonical: attr('link[rel=canonical]', 'href'),
    robotsMeta: attr('meta[name=robots]', 'content'),
    og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')].map((m) => [m.getAttribute('property') || m.getAttribute('name'), m.content])),
    hreflang: [...document.querySelectorAll('link[rel=alternate][hreflang]')].map((l) => ({ hreflang: l.hreflang, href: l.href })),
    bodyClass: document.body.className,
    generator: attr('meta[name=generator]', 'content'),
    jsonld,
    nav: { header: navLinks(document.querySelector('header, [role=banner]')), footer: navLinks(document.querySelector('footer, [role=contentinfo]')) },
    langLinks,
    blocks,
    links: [...document.querySelectorAll('a[href]')].map((a) => abs(a.getAttribute('href'))).filter(Boolean),
    forms,
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src || f.getAttribute('data-src'), title: f.title || null, id: f.id || null })),
    scripts: [...document.scripts].map((s) => (s.src ? { src: s.src } : { inline: s.textContent.slice(0, 600) })),
    assets: [...assets].filter(Boolean),
    globals,
    wordCount: txt(main).split(' ').filter(Boolean).length,
  };
}

// Template type heuristic (refined manually in Phase 2)
function templateType(d, url) {
  const p = new URL(url).pathname.toLowerCase();
  const bc = d.bodyClass || '';
  if (/single-post|\/blog\/|\/news\//.test(bc + p)) return 'article';
  if (/blog|category|archive|news/.test(bc + p)) return 'listing';
  if (/ticket|כרטיס|buy|price|מחיר|order/.test(decodeURIComponent(p))) return 'ticket';
  if (/contact|צור-קשר/.test(decodeURIComponent(p))) return 'contact';
  if (/access|נגישות/.test(decodeURIComponent(p))) return 'accessibility';
  if (/privacy|terms|תקנון|פרטיות/.test(decodeURIComponent(p))) return 'legal';
  if (/faq|שאלות/.test(decodeURIComponent(p))) return 'faq';
  if (/^\/([a-z]{2})?\/?$/.test(p) || (/\bhome\b/.test(bc) && p.split('/').filter(Boolean).length <= 1)) return 'home';
  if (/single-product|\/product\//.test(bc + p)) return 'product';
  if (d.forms.length && d.wordCount < 200) return 'form';
  return 'content';
}

// ---------- crawl ----------
const pages = new Map(); // url -> record
const queue = [normalizeUrl(BASE), ...sitemapUrls.keys()].filter((u) => u && langAllowed(u));
const queued = new Set(queue);
const allowed = (u) => isInternal(u) && langAllowed(u) && !NON_PAGE_EXT.test(new URL(u).pathname) && !disallow.some((d) => d !== '/' && new URL(u).pathname.startsWith(d)) && !/\/(wp-admin|wp-json|xmlrpc|feed)\b|\?(s|replytocom|add-to-cart)=/.test(u);
const enqueue = (u) => { const n = normalizeUrl(u); if (n && allowed(n) && !queued.has(n) && queued.size < MAX_PAGES) { queued.add(n); queue.push(n); } };

const browser = await launch();
const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 } });
await ctx.route('**/*', (r) => (['media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

async function crawlOne(url) {
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType(), method: r.method() }));
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)));
  let status = 0, finalUrl = url, redirectChain = [], error = null, data = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // trigger lazy-load
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
    await page.waitForTimeout(800);
    status = resp?.status() ?? 0; finalUrl = page.url();
    for (let r = resp?.request()?.redirectedFrom(); r; r = r.redirectedFrom()) redirectChain.unshift(r.url());
    data = await page.evaluate(extractInPage);
  } catch (e) { error = String(e.message || e).slice(0, 300); }
  const cookies = (await ctx.cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
  await page.close();
  return { ...(data || {}), pageUrl: data?.url, url, finalUrl, status, redirectChain, error, consoleErrors, requests, cookies };
}

let done = 0;
// Workers finish only when queue is drained and no one is mid-crawl
let active = 0;
await new Promise((resolve) => {
  const spawn = () => {
    while (active < CONCURRENCY && queue.length) {
      active++;
      const url = queue.shift();
      (async () => {
        const rec = await crawlOne(url).catch((e) => ({ url, finalUrl: url, status: 0, error: String(e.message || e).slice(0, 300) }));
        pages.set(url, rec); done++;
        if (done % 10 === 0 || rec.error) log(`${done}/${queued.size} ${rec.status} ${url}${rec.error ? ' ERR ' + rec.error : ''}`);
        if (rec.finalUrl && rec.finalUrl !== url) enqueue(rec.finalUrl);
        for (const l of rec.links || []) enqueue(l);
        for (const l of rec.langLinks || []) enqueue(l.href);
        for (const h of rec.hreflang || []) enqueue(h.href);
        await sleep(DELAY_MS);
      })().finally(() => { active--; if (!queue.length && !active) resolve(); else spawn(); });
    }
    if (!queue.length && !active) resolve();
  };
  spawn();
});
await browser.close();

// ---------- language resolution ----------
function langOf(rec) {
  return langOfUrl(rec.finalUrl || rec.url);
}
const records = [...pages.values()].map((r) => ({ ...r, language: langOf(r) }));
const languages = [...new Set(records.map((r) => r.language))].sort();

// language switcher map: for each page, the alternates per language
for (const r of records) {
  const alt = {};
  for (const h of r.hreflang || []) alt[h.hreflang] = h.href;
  for (const l of r.langLinks || []) { const k = l.hreflang || l.text; if (k && !alt[k]) alt[k] = l.href; }
  r.alternates = alt;
}

// ---------- outputs ----------
const header = ['url', 'final_url', 'language', 'dir', 'title', 'meta_description', 'h1', 'canonical', 'template_type', 'status_code', 'redirect_chain', 'hreflang_count', 'in_sitemap', 'word_count', 'error'];
const lines = [csvRow(header)];
for (const r of records.sort((a, b) => a.language.localeCompare(b.language) || a.url.localeCompare(b.url))) {
  lines.push(csvRow([r.url, r.finalUrl, r.language, r.dir, r.title, r.metaDescription, (r.h1 || []).join(' | '), r.canonical,
    r.error ? 'error' : templateType(r, r.finalUrl), r.status, (r.redirectChain || []).join(' > '), (r.hreflang || []).length,
    sitemapUrls.has(r.url) ? 'y' : 'n', r.wordCount ?? '', r.error ?? '']));
}
fs.writeFileSync(path.join(AUDIT, 'routes.csv'), '﻿' + lines.join('\n') + '\n'); // BOM so Excel renders Hebrew

// content/{lang}/{route}.json — only successful, de-duplicated by final URL
const byFinal = new Map();
for (const r of records) if (!r.error && r.status < 400 && r.blocks && !byFinal.has(r.finalUrl)) byFinal.set(r.finalUrl, r);
for (const r of byFinal.values()) {
  writeJson(path.join(CONTENT, r.language, routeSlug(r.finalUrl) + '.json'), {
    source: r.finalUrl, language: r.language, dir: r.dir, fetchedAt: new Date().toISOString(),
    seo: { title: r.title, description: r.metaDescription, canonical: r.canonical, robots: r.robotsMeta, og: r.og, hreflang: r.hreflang, jsonld: r.jsonld },
    h1: r.h1, alternates: r.alternates, blocks: r.blocks, forms: r.forms, nav: r.nav,
  });
}

writeJson(path.join(AUDIT, 'crawl.json'), { base: BASE, crawledAt: new Date().toISOString(), languages, count: records.length, pages: records });
writeJson(path.join(AUDIT, 'languages.json'), Object.fromEntries(languages.map((l) => [l, {
  pages: records.filter((r) => r.language === l).length,
  dir: records.find((r) => r.language === l)?.dir,
  switcherSamples: records.find((r) => r.language === l)?.langLinks?.slice(0, 10) ?? [],
}])));
log(`done: ${records.length} URLs, ${byFinal.size} unique pages, languages: ${languages.join(', ')}`);
