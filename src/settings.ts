import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Kept independent of config.ts (which reads *this*) to avoid an import cycle.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'data/settings.json');

let cache: Record<string, string> | null = null;

function read(): Record<string, string> {
  if (cache) return cache;
  try {
    const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** A configured value from the settings file, or undefined if unset/blank. */
export function settingValue(key: string): string | undefined {
  const value = read()[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function allSettings(): Record<string, string> {
  return { ...read() };
}

/** Merge a patch: a null or empty value clears the key, anything else sets it. */
export function updateSettings(patch: Record<string, string | null>): void {
  const next = { ...read() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value.trim() === '') delete next[key];
    else next[key] = value.trim();
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  cache = next;
}

export type SettingField = {
  key: string;
  integration: string;
  label: string;
  secret: boolean;
  /** Render as a number input (a small integer setting rather than a credential). */
  number?: boolean;
  help?: string;
  placeholder?: string;
  /** Value used when this field is left unset (non-secret fields only). */
  default?: string;
};

/** A "rows before scroll" field for a source (0 = show all). */
function rowsField(integration: string, key: string, def: string): SettingField {
  return {
    key,
    integration,
    label: 'Rows before scroll',
    secret: false,
    number: true,
    default: def,
    help: '0 shows all rows; otherwise the list caps here and scrolls.',
  };
}

/** User-token scopes the dashboard needs — the single source of truth for the
 *  OAuth flow, the app manifest, and the docs. */
export const SLACK_USER_SCOPES = [
  'search:read',
  'im:read',
  'im:history',
  'mpim:read',
  'mpim:history',
  'users:read',
  'usergroups:read',
];

/** The editable settings surfaced in the in-app configuration screen. */
export const SETTINGS_FIELDS: SettingField[] = [
  {
    key: 'LINEAR_API_KEY',
    integration: 'Linear',
    label: 'Personal API key',
    secret: true,
    help: 'Linear → Settings → Security & access → Personal API keys → New key',
  },
  rowsField('Linear', 'ROWS_LINEAR', '0'),
  {
    key: 'GITLAB_TOKEN',
    integration: 'GitLab',
    label: 'Access token',
    secret: true,
    help: 'Profile → Access tokens, scope: read_api',
  },
  {
    key: 'GITLAB_HOST',
    integration: 'GitLab',
    label: 'Host (optional)',
    secret: false,
    placeholder: 'https://gitlab.com',
    default: 'https://gitlab.com',
    help: 'Defaults to https://gitlab.com — only change for a self-managed instance.',
  },
  rowsField('GitLab', 'ROWS_GITLAB', '0'),
  {
    key: 'SLACK_CLIENT_ID',
    integration: 'Slack',
    label: 'Client ID',
    secret: false,
    help: 'Slack app → Basic Information → App Credentials. Needed for "Connect with Slack".',
  },
  {
    key: 'SLACK_CLIENT_SECRET',
    integration: 'Slack',
    label: 'Client secret',
    secret: true,
    help: 'Slack app → Basic Information → App Credentials.',
  },
  {
    key: 'SLACK_USER_TOKEN',
    integration: 'Slack',
    label: 'User token (xoxp-…)',
    secret: true,
    help: 'Filled automatically by "Connect with Slack", or paste one manually.',
  },
  rowsField('Slack', 'ROWS_SLACK', '5'),
  {
    key: 'GOOGLE_CALENDAR_ICS_URL',
    integration: 'Calendar',
    label: 'Secret iCal URL',
    secret: true,
    help: 'Google Calendar → Settings → your calendar → "Secret address in iCal format".',
  },
  {
    key: 'GOOGLE_CALENDAR_EMAIL',
    integration: 'Calendar',
    label: 'Your calendar email (optional)',
    secret: false,
    help: 'Lets the dashboard hide invitations you declined.',
  },
  rowsField('Calendar', 'ROWS_CALENDAR', '0'),
  rowsField('Reminders', 'ROWS_REMINDERS', '0'),
];
