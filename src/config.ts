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
  /** Seconds between the page's automatic refreshes (0 = off); applied client-side. */
  get refreshSeconds() {
    return int('REFRESH_SECONDS', 120);
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
    /** App credentials for the OAuth "Connect with Slack" flow. */
    get clientId() {
      return str('SLACK_CLIENT_ID');
    },
    get clientSecret() {
      return str('SLACK_CLIENT_SECRET');
    },
    /** Override only if you registered a different redirect URL (e.g. a tunnel). */
    get redirectUrl() {
      return str('SLACK_REDIRECT_URL');
    },
    /** How many recent mentions to pull. */
    get mentionLimit() {
      return int('SLACK_MENTION_LIMIT', 20);
    },
    /** Cap on DM conversations inspected for unread messages. conversations.list
     *  isn't ordered by recency, so this must exceed your DM count or an active
     *  DM can fall outside the scan. */
    get dmScanLimit() {
      return int('SLACK_DM_SCAN_LIMIT', 100);
    },
    /** Comma-separated channels to watch (opt-in Channels widget). */
    get watchChannels() {
      return str('SLACK_WATCH_CHANNELS');
    },
    /** Messages fetched per watched channel. */
    get channelLimit() {
      return int('SLACK_CHANNEL_LIMIT', 10);
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
  /** Per-source row caps before a list scrolls; 0 means show all. */
  rows: {
    get linear() {
      return int('ROWS_LINEAR', 0);
    },
    get gitlab() {
      return int('ROWS_GITLAB', 0);
    },
    get slack() {
      return int('ROWS_SLACK', 5);
    },
    get calendar() {
      return int('ROWS_CALENDAR', 0);
    },
    get channels() {
      return int('ROWS_CHANNELS', 8);
    },
    get reminders() {
      return int('ROWS_REMINDERS', 0);
    },
  },
};

export type Config = typeof config;
