import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env reader. Values already present in the real environment win, so
 * you can override anything for a single run without editing the file.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(projectRoot, '.env'));

function str(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int('PORT', 4300),
  /** Seconds a fetched brief is reused before the next refresh hits the APIs. */
  cacheTtlSeconds: int('CACHE_TTL_SECONDS', 90),
  linear: {
    apiKey: str('LINEAR_API_KEY'),
  },
  gitlab: {
    host: (str('GITLAB_HOST') ?? 'https://gitlab.com').replace(/\/+$/, ''),
    token: str('GITLAB_TOKEN'),
  },
  slack: {
    userToken: str('SLACK_USER_TOKEN'),
    /** How many recent mentions to pull. */
    mentionLimit: int('SLACK_MENTION_LIMIT', 20),
    /** Cap on DM conversations inspected for unread messages. */
    dmScanLimit: int('SLACK_DM_SCAN_LIMIT', 25),
  },
  calendar: {
    icsUrl: str('GOOGLE_CALENDAR_ICS_URL'),
    /** Your calendar address, used to drop invitations you declined. */
    email: str('GOOGLE_CALENDAR_EMAIL')?.toLowerCase(),
  },
} as const;

export type Config = typeof config;
