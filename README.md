# Daily dashboard

One local page with everything on your plate: today's meetings, Slack mentions and
unread DMs, Linear issues assigned to you, and GitLab MRs you own or need to
review.

Runs on `127.0.0.1` only. Your tokens stay in `.env` on this machine and are used
server-side — the browser never sees them.

## Run it

```bash
npm install
cp .env.example .env   # then fill in the sources you want
npm start              # http://localhost:4300
```

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

## Tokens

**Linear** — Settings → Security & access → Personal API keys → New key.
Set `LINEAR_API_KEY`. Shows every non-completed issue assigned to you, with
in-progress work first, then by priority.

**GitLab** — Profile → Access tokens, scope `read_api`. Set `GITLAB_TOKEN`, and
`GITLAB_HOST` if you are on a self-managed instance. Shows MRs awaiting your
review (oldest first, since those block someone) and your own open MRs.

**Slack** — needs a **user** token (`xoxp-…`); bot tokens cannot search your own
messages. Create the app from [`slack-app-manifest.yaml`](slack-app-manifest.yaml),
which pins the scopes to the read-only set:

| scope | what it powers |
| --- | --- |
| `search:read` | your @-mentions |
| `im:read`, `im:history` | unread DMs |
| `mpim:read`, `mpim:history` | unread group DMs |
| `users:read` | names on those DMs |
| `usergroups:read` | mentions of @-aliases (user groups) you're in |

Most workspaces require an admin to approve the install.
**[docs/slack-setup.md](docs/slack-setup.md)** walks through the manifest, the
approval request, and what to do if it is refused.

**Google Calendar** — Calendar settings → pick your calendar → "Secret address in
iCal format". Set `GOOGLE_CALENDAR_ICS_URL`. No OAuth involved, but treat that URL
like a password: anyone holding it can read your calendar. Set
`GOOGLE_CALENDAR_EMAIL` too and invitations you declined are dropped.

## Using it

- `r` or the Refresh button forces a fresh fetch.
- The page auto-refreshes every 2 minutes, and again whenever you return to the tab.
- Responses are cached for `CACHE_TTL_SECONDS` (default 90) so a reload does not
  re-hit every API.
- The browser tab title carries the count of actionable items, so it reads as a
  badge when pinned.
- **Rearrange the cards** by dragging the grip (⠿) in any card header — within a
  column or across to another (empty columns appear as drop targets while you
  drag). The arrangement is saved per-browser in `localStorage`, so it sticks
  across refreshes and restarts. Clearing site data resets it to the default.

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
