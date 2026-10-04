# Phase 1 audit toolkit

Outputs go to `design-docs/` at the repo root (`audit/`, `content/`).

```bash
npm install
npm run all          # or: discover, assets, screenshots, integrations, chat, a11y (in that order)
```

Env: `AUDIT_BASE` (default https://coralworld.co.il), `AUDIT_OUT`, `AUDIT_CONCURRENCY`, `AUDIT_DELAY_MS`,
`AUDIT_MAX_PAGES`, `SHOT_WIDTHS`, `SHOT_ORIENTATIONS`, `LH_FORM_FACTORS`, `SKIP_LIGHTHOUSE=1`, `CHAT_REPLY_TIMEOUT`.

Cloud sandbox notes: Node `fetch` needs `NODE_USE_ENV_PROXY=1` (set in npm scripts); Chromium needs the proxy CA in NSS:
`certutil -A -d sql:$HOME/.pki/nssdb -n ccr-agent-proxy -t "C,," -i /root/.ccr/agent-proxy-ca.crt`.
