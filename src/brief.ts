import { config } from './config.js';
import { errorMessage } from './http.js';
import { fetchCalendar } from './sources/calendar.js';
import { fetchGitlab } from './sources/gitlab.js';
import { fetchLinear } from './sources/linear.js';
import { fetchSlack } from './sources/slack.js';
import type { Brief, Item, Section, SourceKey } from './types.js';

type Loader = {
  source: SourceKey;
  load: () => Promise<Section[]>;
  /** Rendered if the loader throws before it can build its own sections. */
  fallback: { key: string; label: string }[];
};

const LOADERS: Loader[] = [
  { source: 'calendar', load: fetchCalendar, fallback: [{ key: 'calendar-today', label: 'Calendar · today' }] },
  { source: 'slack', load: fetchSlack, fallback: [{ key: 'slack-mentions', label: 'Slack · mentions' }] },
  { source: 'linear', load: fetchLinear, fallback: [{ key: 'linear-assigned', label: 'Linear · assigned to you' }] },
  {
    source: 'gitlab',
    load: fetchGitlab,
    fallback: [
      { key: 'gitlab-review', label: 'GitLab · waiting on your review' },
      { key: 'gitlab-authored', label: 'GitLab · your open MRs' },
    ],
  },
];

function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    const rankA = a.rank ?? 0;
    const rankB = b.rank ?? 0;
    if (rankA !== rankB) return rankA - rankB;
    const timeA = a.timestamp ? Date.parse(a.timestamp) : 0;
    const timeB = b.timestamp ? Date.parse(b.timestamp) : 0;
    return timeB - timeA;
  });
}

export async function buildBrief(): Promise<Brief> {
  const startedAt = Date.now();

  // One slow or broken integration must never take the whole page down.
  const settled = await Promise.all(
    LOADERS.map(async (loader): Promise<Section[]> => {
      try {
        return (await loader.load()).map((section) => ({ ...section, items: sortItems(section.items) }));
      } catch (error) {
        const message = errorMessage(error);
        return loader.fallback.map(({ key, label }) => ({
          key,
          label,
          source: loader.source,
          items: [],
          error: message,
        }));
      }
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sections: settled.flat(),
    rows: {
      linear: config.rows.linear,
      gitlab: config.rows.gitlab,
      slack: config.rows.slack,
      calendar: config.rows.calendar,
      reminders: config.rows.reminders,
    },
    refreshSeconds: config.refreshSeconds,
  };
}

let cached: { brief: Brief; expiresAt: number } | null = null;
let inFlight: Promise<Brief> | null = null;

export async function getBrief(options: { force?: boolean; ttlSeconds: number }): Promise<Brief> {
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.brief;
  // Collapse concurrent requests (two tabs, or a refresh mid-fetch) into one.
  if (inFlight) return inFlight;

  inFlight = buildBrief()
    .then((brief) => {
      cached = { brief, expiresAt: Date.now() + options.ttlSeconds * 1000 };
      return brief;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
