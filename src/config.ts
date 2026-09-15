import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { settingValue } from './settings.js';

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

// In-app settings win over .env, which stays as a fallback for existing setups.
function str(key: string): string | undefined {
  const fromSettings = settingValue(key);
  if (fromSettings) return fromSettings;
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(settingValue(key) ?? process.env[key] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Config is read through getters, so values saved from the settings screen take
 * effect on the next request without a restart.
 */
export const config = {
  get port() {
    return int('PORT', 4300);
  },
  /** Seconds a fetched brief is reused before the next refresh hits the APIs. */
  get cacheTtlSeconds() {
    return int('CACHE_TTL_SECONDS', 90);
  },
  linear: {
    get apiKey() {
      return str('LINEAR_API_KEY');
    },
  },
  gitlab: {
    get host() {
      return (str('GITLAB_HOST') ?? 'https://gitlab.com').replace(/\/+$/, '');
    },
    get token() {
      return str('GITLAB_TOKEN');
    },
  },
  slack: {
    get userToken() {
      return str('SLACK_USER_TOKEN');
    },
    /** How many recent mentions to pull. */
    get mentionLimit() {
      return int('SLACK_MENTION_LIMIT', 20);
    },
    /** Cap on DM conversations inspected for unread messages. */
    get dmScanLimit() {
      return int('SLACK_DM_SCAN_LIMIT', 25);
    },
  },
  calendar: {
    get icsUrl() {
      return str('GOOGLE_CALENDAR_ICS_URL');
    },
    /** Your calendar address, used to drop invitations you declined. */
    get email() {
      return str('GOOGLE_CALENDAR_EMAIL')?.toLowerCase();
    },
  },
};

export type Config = typeof config;
