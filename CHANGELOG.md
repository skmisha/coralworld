# Changelog

All notable changes to the coralworld.co.il rebuild. One section per phase.

## Phase 1 — Discovery (in progress)
- Added `tools/audit/` Playwright toolkit: crawl (robots/sitemaps/hreflang/switcher), asset download + manifest, multi-viewport screenshots (360–1440, portrait/landscape), integration fingerprinting, chat probe (15 questions × languages), axe + Lighthouse (mobile/desktop) baseline.
- Scope decision (owner): Phase 1–5 run on **Hebrew only**; other languages (EN found under `/en/`) translated later. Added `AUDIT_LANGS` (default `he`) and `01b-scope.mjs` to re-scope an existing crawl. Hreflang/alternate links are still recorded per page for the later translation pass.
