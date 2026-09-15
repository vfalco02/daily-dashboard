# Daily dashboard — working notes

A local, single-user web dashboard that aggregates today's work onto one page:
Google Calendar, Linear issues, GitLab MRs, and Slack mentions/DMs, plus a
personal reminders widget. Runs on `127.0.0.1` only; credentials stay server-side.

## Commands

```bash
npm start        # run the server on http://localhost:4300
npm run dev      # same, restarts on file changes (tsx watch)
npm run demo     # serve sample data, no APIs contacted (DEMO=1)
npm run doctor   # check every configured credential, print a specific fix per failure
npm run check    # tsc --noEmit — run this after any change; there is no build step
```

TypeScript is run directly by `tsx` (Node 22, ESM). No bundler, no compile output.
Always run `npm run check` before considering a change done.

## Layout

- `src/server.ts` — HTTP server + all routes: `/api/brief`, `/api/settings`,
  `/api/test/:source`, `/api/reminders*`, `/slack/install`, `/slack/oauth/callback`,
  and static files from `public/`. Loopback bind only.
- `src/brief.ts` — aggregates the sources with per-source error isolation and a
  short TTL cache; attaches per-source `rows` caps. `getBrief({force,ttlSeconds})`.
- `src/sources/{calendar,gitlab,linear,slack}.ts` — one module per source, each
  exporting `() => Promise<Section[]>`.
- `src/config.ts` — config read through **getters** (live per request). Precedence:
  in-app settings (`data/settings.json`) > `.env` > default.
- `src/settings.ts` — settings store (`data/settings.json`) + `SETTINGS_FIELDS`
  schema (drives the settings modal and `/api/settings`) + `SLACK_USER_SCOPES`.
- `src/reminders.ts` — reminders store (`data/reminders.json`).
- `src/http.ts` — `requestJson`, `mapLimit`, error helpers.
- `src/types.ts` — `Item`, `Section`, `Brief`, `Tone`, `SourceKey`.
- `src/demo.ts` — fixture `Brief` for `npm run demo`.
- `src/doctor.ts` — CLI credential checker (shares nothing with the server; own checks).
- `public/` — `index.html`, `app.js` (vanilla JS, no framework), `styles.css`.
- `docs/slack-setup.md`, `slack-app-manifest.yaml` — Slack app setup.

## Conventions & gotchas

- **Secrets never reach the browser.** Tokens live in `data/settings.json` or
  `.env` (both gitignored) and are used server-side. `/api/settings` returns masked
  secrets only. Don't add anything that ships a raw token to the client.
- **`data/` is gitignored** — settings, reminders, and `.env.backup` stay local.
  Never commit credentials.
- **Config is live via getters** — a value saved in Settings takes effect on the
  next request, no restart. Don't destructure `config.*` into a constant at import.
- **Adding a source:** create `src/sources/<name>.ts` exporting
  `() => Promise<Section[]>`, add it to `LOADERS` in `src/brief.ts`, add a
  `rows.<name>` getter in `config.ts` + a `brief.rows` entry, and (optionally)
  settings fields in `SETTINGS_FIELDS`. Sorting, caching, error isolation, and
  rendering are all shared.
- **Frontend is plain DOM** in `public/app.js` — build nodes with the `el()`
  helper; no framework. Per-viewer UI state (card layout, collapsed cards, hidden
  sources) is in `localStorage`; server-side state (settings, reminders) is JSON files.
- **CSS is theme-aware** via tokens on `:root` with a `prefers-color-scheme: dark`
  block. Per-source accent comes from `--src-<source>` resolved through
  `[data-source="…"]`. Times are formatted client-side so they use the viewer's zone.
- **Slack** needs a **user** token (`xoxp-`), never a bot token — only user tokens
  can `search.messages`. Scopes are defined once in `SLACK_USER_SCOPES`. OAuth flow
  lives in `server.ts` (`/slack/install` → `/slack/oauth/callback`).
- **Calendar recurring events**: `node-ical`'s rrule expansion is timezone-naive;
  `occurrenceToLocal()` in `calendar.ts` reinterprets the wall-clock fields. Don't
  "simplify" that away.

## Git

Repo: `https://gitlab.com/vinny_falcone/daily-dashboard.git`, branch `main`. Commit and push
only when asked.
