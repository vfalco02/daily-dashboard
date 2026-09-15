import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config, projectRoot } from './config.js';
import { getBrief } from './brief.js';
import { demoBrief } from './demo.js';
import { addReminder, deleteReminder, listReminders, updateReminder } from './reminders.js';
import { allSettings, SETTINGS_FIELDS, SLACK_USER_SCOPES, updateSettings } from './settings.js';
import { fetchCalendar } from './sources/calendar.js';
import { fetchGitlab } from './sources/gitlab.js';
import { fetchLinear } from './sources/linear.js';
import { fetchSlack, fetchWatchedChannels } from './sources/slack.js';
import type { Section } from './types.js';

/** DEMO=1 serves sample data so you can see the layout before wiring tokens. */
const demoMode = process.env.DEMO === '1';

const publicDir = resolve(projectRoot, 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

/** Reads and parses a JSON request body, capped so a bad client can't exhaust memory. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** Reminder CRUD. Returns true when it handled the request. */
async function handleReminders(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === '/api/reminders') {
    if (req.method === 'GET') {
      sendJson(res, 200, listReminders());
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text ?? '').trim();
      if (!text) sendJson(res, 400, { error: 'text is required' });
      else sendJson(res, 201, addReminder(text.slice(0, 500)));
      return true;
    }
  }

  const match = pathname.match(/^\/api\/reminders\/([\w-]+)$/);
  if (match) {
    const id = match[1] as string;
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const updated = updateReminder(id, {
        done: typeof body.done === 'boolean' ? body.done : undefined,
        text: typeof body.text === 'string' ? body.text : undefined,
      });
      sendJson(res, updated ? 200 : 404, updated ?? { error: 'not found' });
      return true;
    }
    if (req.method === 'DELETE') {
      const removed = deleteReminder(id);
      sendJson(res, removed ? 204 : 404, removed ? undefined : { error: 'not found' });
      return true;
    }
  }

  return false;
}

// ---- Self-update via git ----------------------------------------------------

const execFileAsync = promisify(execFile);

async function git(args: string[], timeoutMs = 20_000): Promise<string> {
  // Non-interactive: never block on a credential/host prompt.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const { stdout } = await execFileAsync('git', args, { cwd: projectRoot, timeout: timeoutMs, env });
  return stdout.trim();
}

async function isGitRepo(): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], 5_000);
    return true;
  } catch {
    return false;
  }
}

/** Fetch and report how far behind/ahead the checkout is vs its upstream. */
async function updateStatus(): Promise<Record<string, unknown>> {
  if (!(await isGitRepo())) return { repo: false };
  try {
    await git(['fetch', '--quiet']);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    let ahead = 0;
    let behind = 0;
    let latest = '';
    if (upstream) {
      const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      const [a, b] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
      ahead = a ?? 0;
      behind = b ?? 0;
      if (behind > 0) latest = await git(['log', '-1', '--pretty=%h %s', '@{u}']);
    }
    const dirty = (await git(['status', '--porcelain'])).length > 0;
    return { repo: true, branch, upstream, ahead, behind, latest, dirty };
  } catch (error) {
    return { repo: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleUpdate(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/api/update') return false;

  if (req.method === 'GET') {
    sendJson(res, 200, await updateStatus());
    return true;
  }
  if (req.method === 'POST') {
    if (!(await isGitRepo())) {
      sendJson(res, 400, { ok: false, error: 'Not a git checkout — nothing to pull.' });
      return true;
    }
    try {
      if ((await git(['status', '--porcelain'])).length > 0) {
        sendJson(res, 409, { ok: false, error: 'You have uncommitted local changes; pull skipped.' });
        return true;
      }
      // What will change tells us whether a server restart is needed.
      const changed = (await git(['diff', '--name-only', 'HEAD', '@{u}']).catch(() => '')).split('\n').filter(Boolean);
      const output = await git(['pull', '--ff-only'], 40_000);
      const codeChanged = changed.some((f) => !f.startsWith('public/') && f !== 'README.md');
      sendJson(res, 200, { ok: true, output, restartNeeded: codeChanged });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  return false;
}

function maskTail(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/** Per-field status for the settings screen — never returns a raw secret. */
function settingsStatus() {
  const saved = allSettings();
  return SETTINGS_FIELDS.map((field) => {
    const fromSettings = saved[field.key]?.trim();
    const fromEnv = process.env[field.key]?.trim();
    const explicit = fromSettings || fromEnv || '';
    const base = {
      key: field.key,
      integration: field.integration,
      label: field.label,
      secret: field.secret,
      number: Boolean(field.number),
      help: field.help,
      placeholder: field.placeholder,
      configured: Boolean(explicit),
      source: fromSettings ? 'settings' : fromEnv ? 'env' : field.default ? 'default' : 'none',
    };
    // Non-secrets echo their value so the form is prefilled — falling back to the
    // field's default (e.g. gitlab.com) so it reads as configured-by-default.
    // Secrets show only a masked tail, and only from the settings file, never .env.
    if (field.secret) return { ...base, preview: fromSettings ? maskTail(fromSettings) : '' };
    return { ...base, value: explicit || field.default || '' };
  });
}

const SOURCE_LOADERS: Record<string, () => Promise<Section[]>> = {
  linear: fetchLinear,
  gitlab: fetchGitlab,
  slack: fetchSlack,
  calendar: fetchCalendar,
  channels: fetchWatchedChannels,
};

/** Run one source's real fetch and report whether it connected. */
async function testSource(source: string): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const load = SOURCE_LOADERS[source];
  if (!load) return { ok: false, error: 'Unknown source' };
  try {
    const sections = await load();
    const failed = sections.find((s) => s.error);
    if (failed?.error) return { ok: false, error: failed.error };
    if (sections.every((s) => s.hint && s.items.length === 0)) return { ok: false, error: 'Not configured' };
    const count = sections.reduce((total, s) => total + s.items.length, 0);
    return { ok: true, detail: `${count} item${count === 1 ? '' : 's'}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleSourceTest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const match = pathname.match(/^\/api\/test\/([a-z]+)$/);
  if (!match || req.method !== 'GET') return false;
  sendJson(res, 200, await testSource(match[1] as string));
  return true;
}

/** Settings read/write. Returns true when it handled the request. */
async function handleSettings(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/api/settings') return false;

  if (req.method === 'GET') {
    sendJson(res, 200, { fields: settingsStatus() });
    return true;
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    const patch: Record<string, string | null> = {};
    for (const field of SETTINGS_FIELDS) {
      if (!(field.key in body)) continue;
      const value = body[field.key];
      patch[field.key] = value === null || typeof value === 'string' ? value : String(value);
    }
    updateSettings(patch);
    sendJson(res, 200, { ok: true, fields: settingsStatus() });
    return true;
  }
  return false;
}

// ---- Slack OAuth ("Connect with Slack") ------------------------------------

// state -> expiry, to guard the callback against forged/replayed requests.
const slackStates = new Map<string, number>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Redirect URL must match the one registered in the Slack app; adapts to the host/port in use. */
function slackRedirectUri(req: IncomingMessage): string {
  if (config.slack.redirectUrl) return config.slack.redirectUrl;
  const host = req.headers.host ?? `localhost:${config.port}`;
  return `http://${host}/slack/oauth/callback`;
}

function sendHtml(res: ServerResponse, status: number, title: string, message: string, redirectTo?: string): void {
  const redirect = redirectTo
    ? `<script>setTimeout(function(){location.href=${JSON.stringify(redirectTo)}},1400)</script>`
    : '';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<div style="font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:420px;margin:18vh auto;padding:0 24px;text-align:center;color:#16181d">` +
      `<h1 style="font-size:18px">${escapeHtml(title)}</h1><p style="color:#626976">${escapeHtml(message)}</p>` +
      `<p><a href="/">Back to the dashboard</a></p></div>${redirect}`,
  );
}

async function handleSlackOauth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/slack/install') {
    if (!config.slack.clientId) {
      sendHtml(res, 400, 'Slack not configured', 'Add the Slack Client ID and secret in Settings first.', '/');
      return true;
    }
    // Prune expired states, then issue a fresh one for this attempt.
    const now = Date.now();
    for (const [value, expiry] of slackStates) if (expiry < now) slackStates.delete(value);
    const state = globalThis.crypto.randomUUID();
    slackStates.set(state, now + 10 * 60_000);

    const authorize = new URL('https://slack.com/oauth/v2/authorize');
    authorize.searchParams.set('client_id', config.slack.clientId);
    authorize.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','));
    authorize.searchParams.set('redirect_uri', slackRedirectUri(req));
    authorize.searchParams.set('state', state);
    res.writeHead(302, { Location: authorize.toString() });
    res.end();
    return true;
  }

  if (url.pathname === '/slack/oauth/callback') {
    const error = url.searchParams.get('error');
    if (error) {
      sendHtml(res, 400, 'Slack', `Authorization was cancelled or failed: ${error}`, '/');
      return true;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!state || !slackStates.has(state)) {
      sendHtml(res, 400, 'Slack', 'This sign-in link expired or was invalid. Please try connecting again.', '/');
      return true;
    }
    slackStates.delete(state);
    if (!code) {
      sendHtml(res, 400, 'Slack', 'Missing authorization code from Slack.', '/');
      return true;
    }

    try {
      const body = new URLSearchParams({
        client_id: config.slack.clientId ?? '',
        client_secret: config.slack.clientSecret ?? '',
        code,
        redirect_uri: slackRedirectUri(req),
      });
      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        authed_user?: { access_token?: string };
      };
      const token = data.authed_user?.access_token;
      if (!data.ok || !token) throw new Error(data.error ?? 'Slack did not return a user token');
      updateSettings({ SLACK_USER_TOKEN: token });
      sendHtml(res, 200, 'Slack connected', 'Slack is connected. Returning to your dashboard…', '/?slack=connected');
    } catch (err) {
      sendHtml(res, 400, 'Slack', `Could not complete the connection: ${err instanceof Error ? err.message : String(err)}`, '/');
    }
    return true;
  }

  return false;
}

async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').slice(1);
  const filePath = join(publicDir, relative);
  if (!filePath.startsWith(publicDir)) return null;
  try {
    const body = await readFile(filePath);
    return { body, type: CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);

  if (url.pathname === '/api/brief') {
    try {
      const brief = demoMode
        ? demoBrief()
        : await getBrief({
            force: url.searchParams.get('refresh') === '1',
            ttlSeconds: config.cacheTtlSeconds,
          });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(brief));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  try {
    if (await handleSlackOauth(req, res, url)) return;
    if (await handleUpdate(req, res, url.pathname)) return;
    if (await handleSourceTest(req, res, url.pathname)) return;
    if (await handleSettings(req, res, url.pathname)) return;
    if (await handleReminders(req, res, url.pathname)) return;
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const asset = await serveStatic(url.pathname);
  if (asset) {
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
    res.end(asset.body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// Loopback only: the brief contains work data and the tokens stay server-side.
server.listen(config.port, '127.0.0.1', () => {
  const enabled = [
    config.linear.apiKey && 'Linear',
    config.gitlab.token && 'GitLab',
    config.slack.userToken && 'Slack',
    config.calendar.icsUrl && 'Calendar',
  ].filter(Boolean);

  console.log(`Daily dashboard  →  http://localhost:${config.port}`);
  if (demoMode) {
    console.log('DEMO mode: serving sample data, no APIs are contacted.');
    return;
  }
  console.log(enabled.length ? `Sources enabled: ${enabled.join(', ')}` : 'No sources configured yet — see .env.example');
});
