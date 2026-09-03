# Pujara & Co. — Task Tracker

Internal office task tracker for Pujara & Co., Chartered Accountants.
Split out of the `pujara-and-co` website repo (September 2026) so the tracker
and the public website deploy independently.

## Layout

- `public/tracker.html` — the entire UI: one self-contained vanilla HTML/CSS/JS file.
  Served at `/tracker` (pretty URL via rewrite) and `/tracker.html`.
- `lib/tracker.ts` — storage + auth core (KV / Blob / local-dev file, token signing, merge-save).
- `app/api/auth/login` — login (mobile + MPIN → signed token).
- `app/api/state` — load/save of the whole tracker state (single JSON document).
- `app/api/office-sheets` — office sheets endpoint.
- `app/api/migrate-to-kv` — one-time Blob → KV migration helper.
- `app/api/[transport]` + `app/api/mcp-oauth/*` + `app/.well-known/*` — MCP server and its OAuth handshake.

## Data

All live data sits in Upstash KV under the key `pujara:tracker:state` — never in this repo.
Environment variables on Vercel: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `AUTH_SECRET`
(must match the values the website project used, so existing logins keep working).

## Local development

```
npm install
npm run dev
```

With no KV/Blob credentials present locally, the app stores data in `.tracker-local.json`
(git-ignored) — live data cannot be touched from a laptop. See `isLocalDev()` in `lib/tracker.ts`.
