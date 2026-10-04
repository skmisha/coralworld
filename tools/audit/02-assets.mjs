// Phase 1 step 3: download every asset referenced by crawled pages -> audit/assets + manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import { AUDIT, UA, ensureDir, writeJson, csvRow, loadRoutes, pool } from './lib.mjs';

const { pages } = loadRoutes();
const DIR = ensureDir(path.join(AUDIT, 'assets'));
const KIND = [
  ['image', /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?)(\?|$)/i],
  ['video', /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i],
  ['audio', /\.(mp3|wav|ogg|m4a)(\?|$)/i],
  ['pdf', /\.pdf(\?|$)/i],
  ['font', /\.(woff2?|ttf|otf|eot)(\?|$)/i],
  ['document', /\.(docx?|xlsx?|pptx?|zip)(\?|$)/i],
];
const kindOf = (u, type) => KIND.find(([, re]) => re.test(u))?.[0] ?? (type === 'image' ? 'image' : type === 'font' ? 'font' : type === 'media' ? 'video' : null);

// url -> { kind, pages:Set }
const assets = new Map();
const add = (u, page, type) => {
  if (!u || u.startsWith('data:') || u.startsWith('blob:')) return;
  const k = kindOf(u, type); if (!k) return;
  if (!assets.has(u)) assets.set(u, { kind: k, pages: new Set() });
  assets.get(u).pages.add(page);
};
for (const p of pages) {
  for (const a of p.assets || []) add(a, p.finalUrl, null);
  for (const r of p.requests || []) if (['image', 'font', 'media'].includes(r.type)) add(r.url, p.finalUrl, r.type);
  for (const b of p.blocks || []) if (b.type === 'video') add(b.src, p.finalUrl, 'media');
}

// Signals that an image is likely stock / third-party licensed
const LICENSE_HINTS = /(shutterstock|istock|gettyimages|adobestock|depositphotos|dreamstime|123rf|alamy|bigstock|unsplash|pexels|pixabay|freepik|stock)/i;

function sniffImage(buf) { try { return imageSize(buf); } catch { return null; } }
function exifCopyright(buf) {
  const s = buf.subarray(0, Math.min(buf.length, 65536)).toString('latin1');
  const m = s.match(/(?:Copyright|©|\(c\)|rights)[^\x00]{0,80}/i) || s.match(/(Shutterstock|Getty Images|iStock|Adobe Stock)[^\x00]{0,40}/i);
  return m ? m[0].replace(/[^\x20-\x7e©]/g, '').trim() : null;
}

const manifest = [];
await pool([...assets.entries()], 6, async ([url, meta]) => {
  const rec = { source_url: url, kind: meta.kind, pages: [...meta.pages], local_path: null, bytes: null, width: null, height: null, content_type: null, status: null, flags: [] };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: rec.pages[0] } });
    rec.status = res.status; rec.content_type = res.headers.get('content-type');
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      rec.bytes = buf.length;
      const u = new URL(url);
      const ext = path.extname(u.pathname) || '';
      const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
      const name = `${path.basename(u.pathname, ext).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || 'asset'}-${hash}${ext}`;
      const rel = path.join(meta.kind, u.hostname, name);
      ensureDir(path.join(DIR, path.dirname(rel)));
      fs.writeFileSync(path.join(DIR, rel), buf);
      rec.local_path = path.join('audit/assets', rel);
      if (meta.kind === 'image') {
        const dim = sniffImage(buf);
        if (dim) { rec.width = dim.width; rec.height = dim.height; }
        if (dim && !/svg/.test(dim.type) && Math.max(dim.width, dim.height) < 1200) rec.flags.push('low-res(<1200px long edge; insufficient for full-bleed hero @2x)');
        if (dim && !/svg/.test(dim.type) && Math.max(dim.width, dim.height) < 600) rec.flags.push('very-low-res(<600px)');
        if (buf.length > 500 * 1024) rec.flags.push('heavy(>500KB)');
        const c = exifCopyright(buf); if (c) rec.flags.push(`embedded-rights-metadata: ${c}`);
      }
      if (meta.kind === 'video' && buf.length > 20 * 1024 * 1024) rec.flags.push('heavy-video(>20MB)');
      if (meta.kind === 'font') rec.flags.push('font-license-check-required');
    }
  } catch (e) { rec.status = 'error'; rec.flags.push('download-failed: ' + String(e.message).slice(0, 100)); }
  if (LICENSE_HINTS.test(url)) rec.flags.push('likely-licensed(stock-name-in-url)');
  if (!new URL(url).hostname.includes('coralworld')) rec.flags.push('third-party-host');
  manifest.push(rec);
});

manifest.sort((a, b) => a.kind.localeCompare(b.kind) || a.source_url.localeCompare(b.source_url));
writeJson(path.join(AUDIT, 'assets', 'manifest.json'), manifest);
const head = ['source_url', 'kind', 'local_path', 'pages_used_on', 'width', 'height', 'bytes', 'content_type', 'status', 'flags'];
fs.writeFileSync(path.join(AUDIT, 'assets', 'manifest.csv'), '﻿' + [csvRow(head), ...manifest.map((m) => csvRow([m.source_url, m.kind, m.local_path, m.pages.join(' | '), m.width, m.height, m.bytes, m.content_type, m.status, m.flags.join('; ')]))].join('\n') + '\n');
const flagged = manifest.filter((m) => m.flags.some((f) => /low-res|licensed|rights|font-license/.test(f)));
console.log(`[assets] ${manifest.length} assets, ${manifest.filter((m) => m.local_path).length} downloaded, ${flagged.length} flagged`);
