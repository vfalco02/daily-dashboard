import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config, projectRoot } from './config.js';
import { getBrief } from './brief.js';
import { demoBrief } from './demo.js';
import { addReminder, deleteReminder, listReminders, updateReminder } from './reminders.js';

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
