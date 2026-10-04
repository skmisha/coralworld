// Shared config + helpers for the Phase 1 audit.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const BASE = process.env.AUDIT_BASE || 'https://coralworld.co.il';
export const ROOT = path.resolve(process.env.AUDIT_OUT || path.join(import.meta.dirname, '..', '..', 'design-docs'));
export const AUDIT = path.join(ROOT, 'audit');
export const CONTENT = path.join(ROOT, 'content');
export const MAX_PAGES = Number(process.env.AUDIT_MAX_PAGES || 2000);
export const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 3);
export const DELAY_MS = Number(process.env.AUDIT_DELAY_MS || 500); // politeness between requests per worker
export const RTL_LANGS = new Set(['he', 'ar', 'fa', 'ur', 'yi']);
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 CoralworldAudit/1.0';

const host = new URL(BASE).hostname.replace(/^www\./, '');
export const isInternal = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, '') === host; } catch { return false; }
};

export function normalizeUrl(u, base = BASE) {
  try {
    const url = new URL(u, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|_ga)/.test(k)) url.searchParams.delete(k);
    url.hostname = url.hostname.replace(/^www\./, '') === host ? new URL(BASE).hostname : url.hostname;
    return url.toString();
  } catch { return null; }
}

export const NON_PAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|m4v|mp3|wav|ogg|pdf|docx?|xlsx?|pptx?|zip|rar|woff2?|ttf|otf|eot|css|js|json|xml|txt)$/i;

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function writeJson(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
export function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// URL -> filesystem-safe route slug, e.g. /he/about/?x=1 -> he__about__q_x-1
export function routeSlug(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '') || 'index';
  if (url.search) p += '__q_' + url.search.slice(1);
  return p.replace(/[\/\\]+/g, '__').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 180);
}

export function csvRow(cols) {
  return cols.map((c) => {
    const s = c == null ? '' : String(c);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

export async function launch() {
  return chromium.launch({ headless: true, args: ['--no-sandbox'] });
}

export async function newContext(browser, opts = {}) {
  return browser.newContext({ userAgent: UA, ignoreHTTPSErrors: false, ...opts });
}

// Simple promise pool.
export async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export function loadRoutes() {
  const p = path.join(AUDIT, 'crawl.json');
  if (!fs.existsSync(p)) throw new Error('Run 01-discover.mjs first (audit/crawl.json missing)');
  return readJson(p);
}

// Language scope. Hebrew is the unprefixed default on coralworld.co.il; other languages live under /xx/.
export const LANGS = (process.env.AUDIT_LANGS || 'he').split(',').map((s) => s.trim()).filter(Boolean);
export function langOfUrl(u) {
  const seg = new URL(u).pathname.split('/')[1]?.toLowerCase() || '';
  return /^[a-z]{2}(-[a-z]{2})?$/.test(seg) ? seg.slice(0, 2) : 'he';
}
export const langAllowed = (u) => LANGS.includes('all') || LANGS.includes(langOfUrl(u));
