import type { Brief } from './types.js';

/** Offsets from "now" keep the sample brief looking live whenever it is opened. */
function at(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

function clock(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Sample data for `npm run demo` — no tokens, no network, just the layout. */
export function demoBrief(): Brief {
  return {
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    rows: { linear: 0, gitlab: 0, slack: 5, calendar: 0, channels: 8, reminders: 0 },
    refreshSeconds: 120,
    sections: [
      {
        key: 'calendar-today',
        label: 'Calendar · today',
        source: 'calendar',
        items: [
          {
            id: 'c1',
            title: 'Standup',
            timeLabel: `${clock(-5)} – ${clock(10)}`,
            badges: [{ label: 'Now', tone: 'urgent' }, { label: 'Join', tone: 'ok' }],
            rank: 1,
            tone: 'urgent',
            url: 'https://meet.google.com/',
          },
          {
            id: 'c2',
            title: 'Claims pipeline design review',
            timeLabel: `${clock(25)} – ${clock(85)}`,
            context: 'Room 4 / Meet',
            badges: [{ label: 'In 25m', tone: 'warn' }, { label: 'Join', tone: 'ok' }],
            rank: 2,
            tone: 'warn',
          },
          { id: 'c3', title: '1:1 with Dana', timeLabel: `${clock(300)} – ${clock(330)}`, rank: 3 },
        ],
      },
      {
        key: 'slack-mentions',
        label: 'Slack · mentions',
        source: 'slack',
        items: [
          {
            id: 's1',
            title: 'Dana Whitfield in #eng-platform',
            excerpt: '@you can you take a look at the retry backoff before we cut the release? Happy to pair.',
            badges: [{ label: 'Unread', tone: 'info' }],
            timestamp: at(-22),
            rank: 0,
            tone: 'info',
          },
          {
            id: 's2',
            title: 'Rui Almeida in #incidents',
            excerpt: '@you the ingest lag alert fired again overnight — I reset it but it wants a real fix.',
            timestamp: at(-190),
            rank: 1000,
            tone: 'neutral',
          },
          {
            id: 's4',
            title: 'Priya Raman in #claims-platform',
            excerpt: '@you thanks for the review yesterday — merged it.',
            timestamp: at(-2600),
            rank: 1001,
            tone: 'neutral',
          },
        ],
      },
      {
        key: 'slack-dms',
        label: 'Slack · unread DMs',
        source: 'slack',
        items: [
          {
            id: 's3',
            title: 'Priya Raman',
            context: '3 unread',
            excerpt: 'sent over the spreadsheet — last tab is the one that matters',
            timestamp: at(-48),
            rank: -3,
            tone: 'warn',
          },
        ],
      },
      {
        key: 'linear-assigned',
        label: 'Linear · assigned to you',
        source: 'linear',
        items: [
          {
            id: 'l1',
            title: 'ENG-812 · Retry backoff drops the last attempt',
            context: 'Claims Platform',
            badges: [
              { label: 'In Progress', tone: 'ok' },
              { label: 'Urgent', tone: 'urgent' },
              { label: 'Due today', tone: 'urgent' },
            ],
            timestamp: at(-95),
            rank: 1,
            tone: 'urgent',
          },
          {
            id: 'l2',
            title: 'ENG-798 · Backfill adjuster assignments',
            context: 'Claims Platform',
            badges: [{ label: 'In Progress', tone: 'ok' }, { label: 'High', tone: 'warn' }],
            timestamp: at(-1400),
            rank: 2,
            tone: 'ok',
          },
          {
            id: 'l3',
            title: 'ENG-840 · Split the intake worker queue',
            context: 'Ingest',
            badges: [{ label: 'Todo' }, { label: 'Medium', tone: 'muted' }],
            timestamp: at(-3000),
            rank: 103,
          },
        ],
      },
      {
        key: 'gitlab-review',
        label: 'GitLab · waiting on your review',
        source: 'gitlab',
        items: [
          {
            id: 'g1',
            title: '!1244 · Add idempotency keys to payout webhook',
            context: 'acme/claims-api',
            badges: [{ label: 'Open 9d', tone: 'warn' }, { label: '12 comments' }, { label: '@rui' }],
            timestamp: at(-2800),
            rank: -9,
            tone: 'warn',
          },
          {
            id: 'g2',
            title: '!1251 · Bump pino and drop the custom serialiser',
            context: 'acme/claims-api',
            badges: [{ label: '2 comments' }, { label: '@priya' }],
            timestamp: at(-260),
            rank: -1,
          },
        ],
      },
      {
        key: 'gitlab-authored',
        label: 'GitLab · your open MRs',
        source: 'gitlab',
        items: [
          {
            id: 'g3',
            title: '!1248 · Fix retry backoff off-by-one',
            context: 'acme/claims-api',
            badges: [{ label: 'Unresolved threads', tone: 'warn' }, { label: '5 comments' }],
            timestamp: at(-70),
            rank: -2,
            tone: 'warn',
          },
          {
            id: 'g4',
            title: '!1253 · Spike: queue partitioning',
            context: 'acme/ingest',
            badges: [{ label: 'Draft', tone: 'muted' }],
            timestamp: at(-900),
            rank: 100,
            tone: 'muted',
          },
        ],
      },
      {
        key: 'slack-channel-engineering',
        label: '#engineering',
        source: 'channels',
        items: [
          {
            id: 'ch1',
            title: 'Dana Whitfield',
            excerpt: 'Deploy is green — 2026.34 is out. Thanks all.',
            timestamp: at(-12),
            rank: 0,
          },
          {
            id: 'ch2',
            title: 'Rui Almeida',
            excerpt: 'Heads up: bumping the ingest workers to 8 for the backfill.',
            timestamp: at(-70),
            rank: 1,
          },
        ],
      },
    ],
  };
}
