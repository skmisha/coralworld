// Phase 1 step 6: fingerprint third-party systems from crawl data -> audit/integrations.md (+ .json)
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT, writeJson, loadRoutes, isInternal } from './lib.mjs';

// [vendor, category, regex over request/script/iframe URLs, global names, cookie names, default disposition]
// disposition: keep = embed as-is, replace = rebuild natively, creds = keep but needs account/API keys from owner
const FP = [
  ['Google Tag Manager', 'tag manager', /googletagmanager\.com\/gtm\.js/, /^dataLayer$/, null, 'creds'],
  ['Google Analytics 4', 'analytics', /google-analytics\.com\/(g\/collect|analytics\.js)|googletagmanager\.com\/gtag\/js/, /^gtag$|^ga$/, /^_ga/, 'creds'],
  ['Google Ads / DoubleClick', 'advertising pixel', /googleadservices\.com|doubleclick\.net|googlesyndication/, null, /^_gcl/, 'creds'],
  ['Meta Pixel', 'advertising pixel', /connect\.facebook\.net\/.*fbevents|facebook\.com\/tr/, /^fbq$|^_fbq$/, /^_fbp$/, 'creds'],
  ['Facebook SDK / embeds', 'social embed', /connect\.facebook\.net\/.*sdk\.js|facebook\.com\/plugins/, /^FB$/, null, 'replace'],
  ['TikTok Pixel', 'advertising pixel', /analytics\.tiktok\.com/, /^ttq$/, /^_ttp$/, 'creds'],
  ['LinkedIn Insight', 'advertising pixel', /snap\.licdn\.com|px\.ads\.linkedin/, /lintrk|_linkedin_partner_id/, null, 'creds'],
  ['Taboola', 'advertising pixel', /taboola\.com/, /^_tfa$/, null, 'creds'],
  ['Outbrain', 'advertising pixel', /outbrain\.com/, /^obApi$/, null, 'creds'],
  ['Hotjar', 'analytics', /hotjar\.com/, /^hj$|_hjSettings/, /^_hj/, 'creds'],
  ['Microsoft Clarity', 'analytics', /clarity\.ms/, /^clarity$/, /^_clck|^_clsk/, 'creds'],
  ['Yandex Metrica', 'analytics', /mc\.yandex\./, /^ym$/, /^_ym/, 'creds'],
  ['Google Maps', 'maps', /maps\.googleapis\.com|google\.com\/maps|maps\.gstatic/, /^google$/, null, 'creds'],
  ['Waze', 'maps', /waze\.com/, null, null, 'keep'],
  ['Moovit', 'maps', /moovitapp\.com/, null, null, 'keep'],
  ['YouTube', 'video host', /youtube(-nocookie)?\.com\/(embed|iframe_api)|ytimg\.com/, /^YT$/, null, 'keep'],
  ['Vimeo', 'video host', /vimeo\.com|vimeocdn/, /^Vimeo$/, null, 'keep'],
  ['Wistia', 'video host', /wistia\.(com|net)/, /^_wq$/, null, 'keep'],
  ['Instagram embed', 'social embed', /instagram\.com\/(embed|p\/)|cdninstagram/, /^instgrm$/, null, 'replace'],
  ['Elfsight widgets', 'social embed / reviews', /elfsight(cdn)?\.com|apps\.elfsight/, /^eapps$/, null, 'replace'],
  ['Trustindex', 'reviews', /trustindex\.io/, /trustindex/i, null, 'replace'],
  ['Trustpilot', 'reviews', /trustpilot\.com/, /^Trustpilot$/, null, 'creds'],
  ['TripAdvisor widget', 'reviews', /tripadvisor\.(com|co\.il)\/(WidgetEmbed|wejs)/, null, null, 'keep'],
  ['Google reCAPTCHA', 'anti-spam', /google\.com\/recaptcha|gstatic\.com\/recaptcha/, /^grecaptcha$/, null, 'creds'],
  ['Cloudflare Turnstile', 'anti-spam', /challenges\.cloudflare\.com/, null, null, 'creds'],
  // Accessibility toolbars (common in Israel for IS 5568)
  ['Nagishli', 'accessibility toolbar', /nagishli/i, /nagishli/i, null, 'replace'],
  ['EqualWeb', 'accessibility toolbar', /equalweb\.com|cdn\.equalweb/, /EqualWeb|INDmenu/i, null, 'replace'],
  ['UserWay', 'accessibility toolbar', /userway\.org/, /userway/i, null, 'replace'],
  ['accessiBe', 'accessibility toolbar', /acsbapp\.com|accessibe\.com/, /^acsb/i, null, 'replace'],
  ['Enable (enable.co.il)', 'accessibility toolbar', /enable\.co\.il|vee-crm|enable_toolbar/i, /enable_toolbar/, null, 'replace'],
  ['Negishut / Access-Plus', 'accessibility toolbar', /negishut|accessplus|all-in-one-accessibility|pojo-accessibility|one-click-accessibility/i, null, null, 'replace'],
  // Cookie consent
  ['OneTrust', 'cookie banner', /cookielaw\.org|onetrust/, /OneTrust|Optanon/, /^OptanonConsent/, 'replace'],
  ['Cookiebot', 'cookie banner', /cookiebot\.com/, /^Cookiebot$/, /^CookieConsent$/, 'replace'],
  ['CookieYes', 'cookie banner', /cookieyes\.com/, /CookieYes/i, /^cookieyes/, 'replace'],
  ['Complianz / GDPR Cookie Consent (WP)', 'cookie banner', /complianz|cookie-law-info|cookie-notice|gdpr-cookie/i, null, /cmplz|cookielawinfo|cookie_notice/, 'replace'],
  // Chat / messaging
  ['WhatsApp click-to-chat', 'chat widget', /wa\.me|api\.whatsapp\.com|whatsapp/i, null, null, 'keep'],
  ['Glassix', 'chat widget', /glassix/i, /glassix/i, null, 'creds'],
  ['Tawk.to', 'chat widget', /tawk\.to/, /^Tawk_API$/, /^TawkConnection/, 'creds'],
  ['Intercom', 'chat widget', /intercom(cdn)?\.(io|com)/, /^Intercom$/, /^intercom-/, 'creds'],
  ['Zendesk Chat', 'chat widget', /zdassets\.com|zopim|zendesk/, /^zE$|\$zopim/, null, 'creds'],
  ['LiveChat', 'chat widget', /livechatinc\.com/, /LiveChatWidget|__lc/, null, 'creds'],
  ['Tidio', 'chat widget', /tidio/, /tidioChatApi/, null, 'creds'],
  ['Crisp', 'chat widget', /crisp\.chat/, /\$crisp/, null, 'creds'],
  ['Freshchat', 'chat widget', /freshchat|wchat\.freshchat/, /fcWidget/, null, 'creds'],
  ['HubSpot', 'CRM / chat', /hs-scripts\.com|hubspot|hsforms|hs-analytics/, /HubSpotConversations|_hsq|hbspt/, /^hubspotutk|__hs/, 'creds'],
  ['Botpress', 'chat widget (bot)', /botpress/, /botpress/i, null, 'replace'],
  ['Voiceflow', 'chat widget (bot)', /voiceflow/, /voiceflow/i, null, 'replace'],
  ['Chatbase / generic AI bot', 'chat widget (bot)', /chatbase\.co|chatling|botsonic|denser\.ai|dante-ai|customgpt/, null, null, 'replace'],
  // CRM / newsletter (Israeli + global)
  ['ActiveTrail', 'CRM / newsletter', /activetrail/i, /activetrail/i, null, 'creds'],
  ['Smoove', 'CRM / newsletter', /smoove\.io|smoove/i, /Smoove/i, null, 'creds'],
  ['Mailchimp', 'CRM / newsletter', /mailchimp|list-manage\.com|chimpstatic/, /mc4wp/, null, 'creds'],
  ['Brevo (Sendinblue)', 'CRM / newsletter', /sendinblue|brevo|sibforms/, /^sib$|Brevo/, null, 'creds'],
  ['Klaviyo', 'CRM / newsletter', /klaviyo/, /_learnq|klaviyo/, null, 'creds'],
  ['Salesforce', 'CRM', /salesforce|force\.com/, /embedded_svc/, null, 'creds'],
  ['Zoho', 'CRM', /zoho/, /\$zoho/, null, 'creds'],
  ['Powerlink / Fireberry', 'CRM', /powerlink|fireberry/i, null, null, 'creds'],
  ['Contact Form 7 / WPForms / Elementor Forms', 'forms', /contact-form-7|wpforms|elementor-pro.*forms|gravityforms/i, null, null, 'replace'],
  // Ticketing / booking / payments (Israel-centric)
  ['SmarTicket', 'ticketing', /smarticket/i, /smarticket/i, null, 'creds'],
  ['Eventer', 'ticketing', /eventer\.co\.il/i, /eventer/i, null, 'creds'],
  ['Tickchak', 'ticketing', /tickchak/i, null, null, 'creds'],
  ['Leaan', 'ticketing', /leaan\.co\.il/i, null, null, 'creds'],
  ['Ticketmaster / Hadran / Zappa / Eventim', 'ticketing', /ticketmaster|hadran|zappa-club|eventim/i, null, null, 'creds'],
  ['Go-Tickets / VenueMaster / Bmby / BOOKIT', 'ticketing', /go-tickets|venuemaster|bmby|bookit|ticketor|tixwise|eventbrite|fareharbor|rezdy|bokun|checkfront|peek\.com|ventrata|convious|accesso|gocity/i, null, null, 'creds'],
  ['WooCommerce', 'ecommerce', /woocommerce|wc-ajax/, /^woocommerce|^wc_/, /^woocommerce_|^wp_woocommerce/, 'replace'],
  ['Tranzila', 'payments', /tranzila/i, /tranzila/i, null, 'creds'],
  ['Cardcom', 'payments', /cardcom/i, /cardcom/i, null, 'creds'],
  ['Meshulam / Grow', 'payments', /meshulam|grow\.(link|business)/i, null, null, 'creds'],
  ['PayPlus', 'payments', /payplus/i, null, null, 'creds'],
  ['Pelecard', 'payments', /pelecard/i, null, null, 'creds'],
  ['iCredit (Rivhit)', 'payments', /icredit|rivhit/i, null, null, 'creds'],
  ['Stripe', 'payments', /js\.stripe\.com|stripe\.com/, /^Stripe$/, null, 'creds'],
  ['PayPal', 'payments', /paypal(objects)?\.com/, /^PayPal$|^paypal$/, null, 'creds'],
  ['Bit / Apple Pay / Google Pay', 'payments', /bitpay\.co\.il|pay\.google\.com|apple-pay/i, null, null, 'creds'],
  // Platform / infra (informational)
  ['WordPress', 'CMS/platform', /\/wp-(content|includes)\//, null, /^wp-settings|^wordpress_/, 'replace'],
  ['Elementor', 'CMS/platform', /elementor/, /elementorFrontend/, null, 'replace'],
  ['WPML', 'i18n plugin', /sitepress-multilingual|wpml/i, /icl_vars|wpml/i, /^wp-wpml|_icl_/, 'replace'],
  ['Polylang', 'i18n plugin', /polylang/i, null, /^pll_language/, 'replace'],
  ['Weglot', 'i18n plugin', /weglot/i, /Weglot/i, null, 'replace'],
  ['Wix', 'CMS/platform', /wixstatic|parastorage|wix\.com/, /wixBiSession|Wix/, null, 'replace'],
  ['Cloudflare', 'CDN/security', /cdnjs\.cloudflare|cloudflareinsights|\/cdn-cgi\//, null, /^__cf/, 'keep'],
  ['Google Fonts', 'fonts', /fonts\.(googleapis|gstatic)\.com/, null, null, 'replace'],
  ['Adobe Fonts (Typekit)', 'fonts', /use\.typekit\.net|p\.typekit/, null, null, 'creds'],
  ['Font Awesome', 'icons', /fontawesome|font-awesome/, null, null, 'replace'],
  ['jsDelivr / unpkg / cdnjs', 'CDN', /cdn\.jsdelivr|unpkg\.com/, null, null, 'replace'],
];

const DISP = { keep: 'Keep (embed / link as-is)', replace: 'Replace (rebuild natively in new stack)', creds: 'Keep — needs credentials / account access from owner' };

const { pages } = loadRoutes();
const found = new Map(); // vendor -> {cat, disp, pages:Set, evidence:Set, how:Set}
const unknownHosts = new Map();
const hit = (fp, page, how, ev) => {
  const [vendor, cat, , , , disp] = fp;
  if (!found.has(vendor)) found.set(vendor, { vendor, category: cat, disposition: disp, pages: new Set(), how: new Set(), evidence: new Set() });
  const f = found.get(vendor); f.pages.add(page); f.how.add(how); if (f.evidence.size < 8) f.evidence.add(ev.slice(0, 160));
};

for (const p of pages) {
  const page = p.finalUrl || p.url;
  const urls = [
    ...(p.requests || []).map((r) => [r.url, `network:${r.type}`]),
    ...(p.scripts || []).filter((s) => s.src).map((s) => [s.src, 'script tag']),
    ...(p.iframes || []).filter((f) => f.src).map((f) => [f.src, 'iframe']),
    ...(p.links || []).filter((l) => !isInternal(l)).map((l) => [l, 'outbound link']),
    ...(p.forms || []).filter((f) => f.action).map((f) => [f.action, 'form action']),
  ];
  for (const [u, how] of urls) {
    let matched = false;
    for (const fp of FP) if (fp[2] && fp[2].test(u)) { hit(fp, page, how, u); matched = true; }
    if (!matched && !isInternal(u) && how !== 'outbound link') { try { const h = new URL(u).hostname; unknownHosts.set(h, (unknownHosts.get(h) || 0) + 1); } catch {} }
  }
  for (const s of (p.scripts || []).filter((s) => s.inline)) for (const fp of FP) if (fp[2] && fp[2].test(s.inline)) hit(fp, page, 'inline script', s.inline.replace(/\s+/g, ' '));
  for (const g of p.globals || []) for (const fp of FP) if (fp[3] && fp[3].test(g)) hit(fp, page, 'JS global', `window.${g}`);
  for (const c of p.cookies || []) for (const fp of FP) if (fp[4] && fp[4].test(c.name)) hit(fp, page, 'cookie', `${c.name} @ ${c.domain}`);
}

const total = pages.length;
const where = (s) => (s.size >= total * 0.9 ? `all pages (${s.size})` : s.size > 5 ? `${s.size} pages, e.g. ${[...s].slice(0, 3).join(', ')}` : [...s].join(', '));
const list = [...found.values()].sort((a, b) => a.category.localeCompare(b.category) || a.vendor.localeCompare(b.vendor));
writeJson(path.join(AUDIT, 'integrations.json'), list.map((f) => ({ ...f, pages: [...f.pages], how: [...f.how], evidence: [...f.evidence] })));

const cookies = new Map();
for (const p of pages) for (const c of p.cookies || []) cookies.set(`${c.name}|${c.domain}`, c);
const forms = pages.flatMap((p) => (p.forms || []).map((f) => ({ page: p.finalUrl, ...f })));

let md = `# Third-party integrations — ${new URL(pages[0]?.finalUrl || 'https://coralworld.co.il').hostname}\n\n`;
md += `_Generated ${new Date().toISOString()} from ${total} crawled URLs by tools/audit/04-integrations.mjs. Automated fingerprinting; every row must be confirmed manually (see "Manual verification" below)._\n\n`;
md += `**Dispositions:** ${Object.values(DISP).join(' · ')}\n\n`;
md += `| Vendor | Category | Where it appears | How embedded | Evidence | Disposition |\n|---|---|---|---|---|---|\n`;
for (const f of list) md += `| ${f.vendor} | ${f.category} | ${where(f.pages)} | ${[...f.how].join(', ')} | ${[...f.evidence].slice(0, 2).map((e) => '`' + e.replace(/\|/g, '\\|') + '`').join('<br>')} | ${DISP[f.disposition]} |\n`;
const cats = ['ticketing', 'payments', 'chat widget', 'CRM / newsletter', 'analytics', 'tag manager', 'maps', 'video host', 'accessibility toolbar', 'cookie banner', 'reviews', 'social embed'];
const missing = cats.filter((c) => !list.some((f) => f.category.includes(c)));
if (missing.length) md += `\n**Required categories with no automated match** (verify manually — may be absent, loaded only after interaction, or an unfingerprinted vendor): ${missing.join(', ')}\n`;
md += `\n## Unrecognised third-party hosts\n\n| Host | Requests |\n|---|---|\n${[...unknownHosts].sort((a, b) => b[1] - a[1]).map(([h, n]) => `| ${h} | ${n} |`).join('\n') || '| — | — |'}\n`;
md += `\n## Forms (${forms.length})\n\n| Page | Action | Method | Fields |\n|---|---|---|---|\n${forms.map((f) => `| ${f.page} | ${f.action || '(js)'} | ${f.method} | ${f.fields.map((x) => x.name || x.id).join(', ')} |`).join('\n') || '| — | — | — | — |'}\n`;
md += `\n## Cookies set without interaction (${cookies.size})\n\n| Name | Domain | Expires | Secure | SameSite |\n|---|---|---|---|---|\n${[...cookies.values()].map((c) => `| ${c.name} | ${c.domain} | ${c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : 'session'} | ${c.secure} | ${c.sameSite} |`).join('\n')}\n`;
md += `\nCookies present before any consent click indicate a consent-compliance gap to fix in the rebuild.\n`;
md += `\n## Manual verification checklist\n\n- [ ] Click "Buy tickets" in every language and record the full ticketing flow (domain, steps, payment page, wallet support).\n- [ ] Open chat widget; confirm vendor + whether it is bot, human, or hybrid (see audit/chat/).\n- [ ] Confirm GTM container ID and list tags inside it (requires GTM access).\n- [ ] Confirm newsletter/CRM list IDs and form endpoints.\n- [ ] Confirm accessibility toolbar vendor contract and statement ownership.\n`;
fs.writeFileSync(path.join(AUDIT, 'integrations.md'), md);
console.log(`[integrations] ${list.length} vendors detected; missing categories: ${missing.join(', ') || 'none'}`);
