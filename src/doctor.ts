/**
 * `npm run doctor` — checks each integration one at a time and says exactly what
 * to fix. Runs the same code paths the dashboard uses, so a pass here means the
 * page will work.
 */
import { config } from './config.js';
import { errorMessage } from './http.js';
import { slack, SlackApiError } from './sources/slack.js';
import { fetchCalendar } from './sources/calendar.js';
import { fetchGitlab } from './sources/gitlab.js';
import { fetchLinear } from './sources/linear.js';
import type { Section } from './types.js';

type Result =
  | { status: 'ok'; detail: string }
  | { status: 'skip'; detail: string }
  | { status: 'fail'; detail: string; fix?: string };

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[90m';
const RESET = '[0m';

const ICONS: Record<Result['status'], string> = {
  ok: `${GREEN}✓${RESET}`,
  fail: `${RED}✗${RESET}`,
  skip: `${DIM}○${RESET}`,
};

/** Turns a raw upstream error into something you can act on. */
function diagnose(service: string, message: string): string | undefined {
  if (/\b401\b|unauthorized|authentication/i.test(message)) {
    return `${service} rejected the credential. Check it was copied whole and has not expired.`;
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return `${service} accepted the credential but denied the request — it is missing a scope or permission.`;
  }
  if (/\b404\b/.test(message)) {
    return `${service} could not find that resource. Check any host or id you configured.`;
  }
  if (/\b429\b|rate.?limit/i.test(message)) return `${service} is rate limiting. Wait a minute and retry.`;
  if (/timed out|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(message)) {
    return `Could not reach ${service}. Check the host URL and whether this needs the VPN.`;
  }
  return undefined;
}

/** Wraps a source's own fetch so a pass here proves the dashboard path works. */
async function checkSource(
  service: string,
  load: () => Promise<Section[]>,
  describe: (sections: Section[]) => string,
): Promise<Result> {
  let sections: Section[];
  try {
    sections = await load();
  } catch (error) {
    const message = errorMessage(error);
    return { status: 'fail', detail: message, fix: diagnose(service, message) };
  }

  const failed = sections.find((section) => section.error);
  if (failed?.error) {
    return { status: 'fail', detail: failed.error, fix: diagnose(service, failed.error) };
  }

  // Every section unconfigured means the credential is simply absent.
  if (sections.every((section) => section.hint && section.items.length === 0)) {
    return { status: 'skip', detail: sections[0]?.hint ?? 'Not configured.' };
  }

  return { status: 'ok', detail: describe(sections) };
}

function count(sections: Section[], key: string): number {
  return sections.find((section) => section.key === key)?.items.length ?? 0;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Slack gets its own probe: a token can authenticate fine and still be missing
 * one of the scope groups, and the fix differs for each.
 */
async function checkSlack(): Promise<Result[]> {
  if (!config.slack.userToken) {
    return [{ status: 'skip', detail: 'Set SLACK_USER_TOKEN in .env to enable.' }];
  }

  if (!config.slack.userToken.startsWith('xoxp-')) {
    return [
      {
        status: 'fail',
        detail: `Token starts with "${config.slack.userToken.slice(0, 5)}", not "xoxp-".`,
        fix: 'This looks like a bot token. Only a User OAuth Token (xoxp-) can search your own messages — copy the one labelled "User OAuth Token" on the OAuth & Permissions page.',
      },
    ];
  }

  const results: Result[] = [];

  let identity: string;
  try {
    const me = await slack<{ ok: boolean; user: string; team: string }>('auth.test', {});
    identity = me.user;
    results.push({ status: 'ok', detail: `authenticated as @${me.user}` });
  } catch (error) {
    const message = errorMessage(error);
    return [
      {
        status: 'fail',
        detail: message,
        fix:
          error instanceof SlackApiError && error.code === 'invalid_auth'
            ? 'The token is not valid. Reinstall the app to your workspace and copy the fresh User OAuth Token.'
            : diagnose('Slack', message),
      },
    ];
  }

  const probes: { name: string; scope: string; run: () => Promise<string> }[] = [
    {
      name: 'mentions',
      scope: 'search:read',
      run: async () => {
        const found = await slack<{ ok: boolean; messages?: { matches?: unknown[] } }>('search.messages', {
          query: `@${identity}`,
          count: '1',
        });
        return `search works (${plural(found.messages?.matches?.length ?? 0, 'match', 'matches')} on a sample query)`;
      },
    },
    {
      name: 'DMs',
      scope: 'im:read, im:history, mpim:read, mpim:history',
      run: async () => {
        const list = await slack<{ ok: boolean; channels?: unknown[] }>('users.conversations', {
          types: 'im,mpim',
          limit: '1',
        });
        return `can list DMs (${plural(list.channels?.length ?? 0, 'conversation')} sampled)`;
      },
    },
    {
      name: 'names',
      scope: 'users:read',
      run: async () => {
        await slack<{ ok: boolean }>('users.info', { user: 'USLACKBOT' });
        return 'can resolve display names';
      },
    },
  ];

  for (const probe of probes) {
    try {
      results.push({ status: 'ok', detail: await probe.run() });
    } catch (error) {
      const needed = error instanceof SlackApiError ? error.needed : undefined;
      results.push({
        status: 'fail',
        detail: `${probe.name}: ${errorMessage(error)}`,
        fix: `Add the ${needed ? `"${needed}"` : `"${probe.scope}"`} User Token Scope at api.slack.com/apps → OAuth & Permissions, then reinstall the app and copy the new token.`,
      });
    }
  }

  return results;
}

function print(name: string, result: Result): void {
  console.log(`  ${ICONS[result.status]} ${name.padEnd(10)} ${result.detail}`);
  if (result.status === 'fail' && result.fix) {
    console.log(`    ${DIM}-> ${result.fix}${RESET}`);
  }
}

async function main(): Promise<void> {
  console.log('\nDaily dashboard · connection check\n');

  const [linear, gitlab, calendar, slackResults] = await Promise.all([
    checkSource('Linear', fetchLinear, (s) => `${plural(count(s, 'linear-assigned'), 'issue')} assigned to you`),
    checkSource(
      'GitLab',
      fetchGitlab,
      (s) =>
        `${plural(count(s, 'gitlab-authored'), 'open MR')} of your own, ` +
        `${count(s, 'gitlab-review')} awaiting your review`,
    ),
    checkSource('Calendar', fetchCalendar, (s) => `${plural(count(s, 'calendar-today'), 'event')} today`),
    checkSlack(),
  ]);

  print('Linear', linear);
  print('GitLab', gitlab);
  for (const [index, result] of slackResults.entries()) {
    print(index === 0 ? 'Slack' : '', result);
  }
  print('Calendar', calendar);

  const all = [linear, gitlab, calendar, ...slackResults];
  const failed = all.filter((r) => r.status === 'fail').length;
  const skipped = all.filter((r) => r.status === 'skip').length;

  console.log('');
  if (failed) {
    console.log(`${failed} check${failed === 1 ? '' : 's'} failed — see the -> lines above.`);
    process.exitCode = 1;
  } else if (skipped === all.length) {
    console.log('Nothing configured yet. Fill in .env and run this again.');
  } else {
    console.log('All configured sources are working. Run `npm start`.');
  }
  console.log('');
}

await main();
