# Daily dashboard

One local page with everything on your plate: today's meetings, Slack mentions and
unread DMs, Linear issues assigned to you, and GitLab MRs you own or need to
review.

Runs on `127.0.0.1` only. Your tokens stay on this machine — entered in the app's
Settings screen (saved to `data/settings.json`) or in a `.env` file — and are used
server-side, so the browser never sees them.

## Run it

```bash
npm install
npm start              # http://localhost:4300
```

Then click **⚙ Settings** in the top bar and paste in the tokens for whichever
sources you want — saved to `data/settings.json` (gitignored) and applied on the
next refresh, no restart needed. See [Connecting your sources](#connecting-your-sources)
for where each token comes from (and the `.env` alternative).

See the layout with sample data before wiring anything up:

```bash
npm run demo
```

Check your credentials before starting the server:

```bash
npm run doctor
```

It exercises the same code paths the dashboard uses and prints a line per source —
what worked, what failed, and the specific fix. A clean run means the page will work.

Other scripts: `npm run dev` (restart on file changes), `npm run check` (typecheck).

Every source is optional. Anything you leave blank renders as a hint card instead
of an error, and one failing integration never takes the page down.

## Connecting your sources

Open **⚙ Settings** and fill in whichever sources you want — each takes effect on
the next refresh.

Prefer files? Each setting below names the equivalent `.env` variable, so you can
put them all in a `.env` instead (`cp .env.example .env`). If both are present, the
Settings screen wins.

**Linear** — Settings → Security & access → Personal API keys → New key. Paste into
**Settings → Linear → Personal API key** (env: `LINEAR_API_KEY`). Shows every
non-completed issue assigned to you, in-progress first, then by priority.

**GitLab** — Profile → Access tokens, scope `read_api`. Paste into **Settings →
GitLab → Access token** (env: `GITLAB_TOKEN`). Host defaults to `https://gitlab.com`;
set it only for a self-managed instance (env: `GITLAB_HOST`). Shows MRs awaiting
your review (oldest first, since those block someone) and your own open MRs.

**Slack** — needs a **user** token (`xoxp-…`); bot tokens can't search your own
messages. Create the app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml),
which pins these read-only scopes:

| scope | what it powers |
| --- | --- |
| `search:read` | your @-mentions |
| `im:read`, `im:history` | unread DMs |
| `mpim:read`, `mpim:history` | unread group DMs |
| `users:read` | names on those DMs |
| `usergroups:read` | mentions of @-aliases (user groups) you're in |

Two ways to get the token into the app:
- **Connect with Slack** (recommended) — paste the app's Client ID and Secret into
  **Settings → Slack**, save, then click **Connect with Slack** to authorize; the
  token is captured for you (env: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`).
  Authorizing sends you to Slack and back, which closes the settings popup — so
  reopen **⚙ Settings → Slack** and hit **Save & test** to confirm it connected.
- **Paste a token** — copy the User OAuth Token into **Settings → Slack → User
  token** (env: `SLACK_USER_TOKEN`).

Most workspaces require an admin to approve the install.
**[docs/slack-setup.md](docs/slack-setup.md)** walks through the manifest, both
token paths, the approval request, and what to do if it's refused.

**Google Calendar** — Calendar settings → pick your calendar → "Secret address in
iCal format". Paste into **Settings → Calendar → Secret iCal URL** (env:
`GOOGLE_CALENDAR_ICS_URL`). No OAuth, but treat that URL like a password — anyone
holding it can read your calendar. Add your calendar email (env:
`GOOGLE_CALENDAR_EMAIL`) to drop invitations you've declined.

Run `npm run doctor` any time to check every configured source and get a specific
fix for whatever fails.

## Using it

- `r` or the Refresh button forces a fresh fetch.
- The page auto-refreshes every 2 minutes (change it with the Auto-refresh dropdown
  at the top of ⚙ Settings — Off / 15s / 30s / 1m / 2m), and again whenever you
  return to the tab.
- Responses are cached for `CACHE_TTL_SECONDS` (default 90) so a reload does not
  re-hit every API.
- The browser tab title carries the count of actionable items, so it reads as a
  badge when pinned.
- **Show/hide a widget** with its pill in the top bar — one per source plus
  Reminders. Click to drop that widget's cards from the board (the pill dims);
  click again to bring them back. Saved per-browser.
- **Rearrange the cards** by dragging the grip (⠿) in any card header — within a
  column or across to another (empty columns appear as drop targets while you
  drag). The arrangement is saved per-browser in `localStorage`, so it sticks
  across refreshes and restarts. Clearing site data resets it to the default.
- **Collapse a card** by clicking its header (or the ▾ chevron); the count stays
  visible in the header. Collapsed state is also saved per-browser.
- **Cap rows per source** in ⚙ Settings — each source (and Reminders) has a
  "Rows before scroll" number; 0 shows all, anything else caps the list there and
  scrolls the rest. Slack defaults to 5, the others to unlimited.

## Reminders

The one widget you write to rather than read from an API. Type a reminder and
press Enter (or the **+** button); click the checkbox to complete it, or the ×
to delete. Completed items sort to the bottom, dimmed. The card count shows how
many are still open.

Reminders are stored server-side in `data/reminders.json` (gitignored), so they
survive restarts, cache clears, and a different browser — unlike the rest of the
page, which is read-only and re-fetched each refresh. Back them up by copying
that file. The REST endpoints, if you want to script against them, are
`GET/POST /api/reminders` and `PATCH/DELETE /api/reminders/:id`.

## Adding a source

Each integration is a file in `src/sources/` exporting
`() => Promise<Section[]>`, where a `Section` is a titled list of `Item`s
(`src/types.ts`). Write the file, add it to the `LOADERS` array in
`src/brief.ts`, and it appears on the page — sorting, error handling, caching and
rendering are all shared.
