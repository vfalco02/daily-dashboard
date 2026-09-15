# Slack setup

Slack is the only source here that needs someone else's approval. Most
workspaces let anyone *create* an app but require an admin to approve the
*install*. That request is a form in Slack, not an email thread — this page has
the manifest and the text to put in it.

## 1. Create the app from the manifest

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick your workspace.
3. Paste the contents of [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) (switch the editor to YAML).
4. Create.

Using the manifest matters: it pins the scopes to the exact read-only set. Adding
them by hand is where people accidentally request a bot token or a write scope,
which turns a routine approval into a conversation.

## 2. Request the install

On **Install App** (or **OAuth & Permissions**) click **Request to Install**.
Slack shows a reason box. Something like:

> This is a personal read-only dashboard that runs on my laptop at localhost. It
> shows my own Slack mentions and unread DMs next to my Linear issues, GitLab
> MRs and calendar so I don't have to poll five tools every morning.
>
> It requests **user scopes only** — `search:read`, `im:read`, `im:history`,
> `mpim:read`, `mpim:history`, `users:read`, `usergroups:read` — so it can read
> exactly what I can already read in the Slack client and nothing more. There is no bot user, no
> write scopes, and no event subscriptions: it cannot post, edit, delete or react
> to anything, and nothing in the workspace can invoke it.
>
> No message content leaves my machine. The app fetches on demand, renders in my
> browser, and keeps nothing on disk. Revoking the token in the admin console
> stops it immediately.

Two details worth keeping if you rewrite it: **user scopes only, no write
access** is the thing that makes this a low-risk approval, and **revocable from
the admin console** is the thing that makes it an easy yes.

## 3. Once approved — get the token

Two ways; both end with a `xoxp-` user token the dashboard uses.

### A. Connect from the app (recommended)

The manifest already registers the redirect URL
`http://localhost:4300/slack/oauth/callback`, so OAuth works out of the box:

1. In the Slack app, open **Basic Information → App Credentials** and copy the
   **Client ID** and **Client Secret**.
2. In the dashboard, open **⚙ Settings → Slack**, paste both, and **Save**.
3. Reopen Settings and click **Connect with Slack**. Approve the consent screen;
   Slack sends you back and the user token is stored automatically.

The token never has to be copied by hand, and the same flow works for a teammate
on their own machine (each person authorizes and gets their own token from the
one shared app). If you run the dashboard on a different port, register a matching
redirect URL and set `SLACK_REDIRECT_URL`.

### B. Paste a token manually

Copy the **User OAuth Token** (starts with `xoxp-`) from **OAuth & Permissions**
into **⚙ Settings → Slack → User token** (or `SLACK_USER_TOKEN` in `.env`).

Either way, verify with:

```bash
npm run doctor
```

The Slack check probes each scope group separately, so if one scope did not make
it through the approval you will see exactly which.

## If the install is refused

The rest of the dashboard works without it — the two Slack cards render as hints
and nothing else changes. Worth asking the admin whether your workspace has an approved
route for personal read-only integrations; some workspaces keep a pre-approved
internal app for exactly this.

> One thing deliberately not supported here: reusing the `xoxc-`/`d`-cookie
> session that the Slack desktop client holds. It is technically possible and
> widely documented, but it exists specifically to route around the install
> approval your admins configured. Ask for the token instead.
