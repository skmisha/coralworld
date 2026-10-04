// Re-scope an existing crawl to AUDIT_LANGS without re-crawling: filters crawl.json, routes.csv, content/.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT, CONTENT, LANGS, langAllowed, writeJson, readJson } from './lib.mjs';

const crawl = readJson(path.join(AUDIT, 'crawl.json'));
const before = crawl.pages.length;
crawl.pages = crawl.pages.filter((p) => langAllowed(p.finalUrl || p.url));
crawl.languages = [...new Set(crawl.pages.map((p) => p.language))];
crawl.count = crawl.pages.length;
crawl.scope = LANGS;
writeJson(path.join(AUDIT, 'crawl.json'), crawl);

const csv = fs.readFileSync(path.join(AUDIT, 'routes.csv'), 'utf8').split('\n');
const keep = [csv[0], ...csv.slice(1).filter((l) => { const u = l.split(',')[1]; return u && langAllowed(u.replace(/^"|"$/g, '')); })];
fs.writeFileSync(path.join(AUDIT, 'routes.csv'), keep.join('\n') + '\n');

for (const d of fs.readdirSync(CONTENT)) if (!LANGS.includes(d)) fs.rmSync(path.join(CONTENT, d), { recursive: true, force: true });
const langs = readJson(path.join(AUDIT, 'languages.json'));
writeJson(path.join(AUDIT, 'languages.json'), { scope: LANGS, ...langs });
console.log(`[scope] ${LANGS.join(',')}: kept ${crawl.pages.length}/${before} pages, ${keep.length - 1} csv rows`);
