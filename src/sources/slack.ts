import { config } from '../config.js';
import { mapLimit, requestJson } from '../http.js';
import type { Badge, Item, Section } from '../types.js';

type SlackEnvelope = { ok: boolean; error?: string; needed?: string; provided?: string };

type SlackMatch = {
  iid?: string;
  ts: string;
  text: string;
  permalink?: string;
  username?: string;
  user?: string;
  channel?: { id: string; name?: string; is_private?: boolean; is_im?: boolean };
};

type SearchResponse = SlackEnvelope & { messages?: { matches?: SlackMatch[] } };
type AuthResponse = SlackEnvelope & { user_id: string; user: string; team: string };
type ConversationsResponse = SlackEnvelope & {
  channels?: { id: string; user?: string }[];
};
type ConversationInfoResponse = SlackEnvelope & {
  channel?: { id: string; last_read?: string; user?: string };
};
type HistoryResponse = SlackEnvelope & {
  messages?: { ts: string; text?: string; user?: string; subtype?: string }[];
};
type UserInfoResponse = SlackEnvelope & {
  user?: { id: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
};
type UserGroupsResponse = SlackEnvelope & {
  usergroups?: { id: string; handle: string; name: string; date_delete?: number; users?: string[] }[];
};

/** Carries Slack's scope hints through, which is what you actually need to fix. */
export class SlackApiError extends Error {
  readonly code: string;
  readonly needed?: string;

  constructor(method: string, payload: SlackEnvelope) {
    const code = payload.error ?? 'unknown_error';
    const scopes = payload.needed ? ` (missing scope: ${payload.needed})` : '';
    super(`slack.${method} failed: ${code}${scopes}`);
    this.name = 'SlackApiError';
    this.code = code;
    this.needed = payload.needed;
  }
}

export async function slack<T extends SlackEnvelope>(method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const payload = await requestJson<T>('Slack', url.toString(), {
    headers: { Authorization: `Bearer ${config.slack.userToken as string}` },
  });
  if (!payload.ok) throw new SlackApiError(method, payload);
  return payload;
}

/** Slack timestamps are "1699999999.000100" seconds-with-microseconds. */
function tsToIso(ts: string): string {
  return new Date(Number.parseFloat(ts) * 1000).toISOString();
}

/** Common Slack emoji shortcodes → Unicode. Unknown/custom ones are left as-is. */
const EMOJI: Record<string, string> = {
  date: '📅', calendar: '📅', spiral_calendar_pad: '📅',
  thread: '🧵', speech_balloon: '💬', loudspeaker: '📢', mega: '📣',
  white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️', check: '✅',
  x: '❌', no_entry: '⛔', no_entry_sign: '🚫',
  warning: '⚠️', rotating_light: '🚨', fire: '🔥', boom: '💥',
  red_circle: '🔴', large_yellow_circle: '🟡', yellow_circle: '🟡',
  large_green_circle: '🟢', green_circle: '🟢', white_circle: '⚪', large_blue_circle: '🔵',
  eyes: '👀', wave: '👋', pray: '🙏', clap: '👏', raised_hands: '🙌', ok_hand: '👌',
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎',
  rocket: '🚀', tada: '🎉', party: '🎉', '100': '💯', sos: '🆘',
  bell: '🔔', lock: '🔒', bug: '🐛', ship: '🚢', shipit: '🚢', construction: '🚧',
  hourglass: '⌛', hourglass_flowing_sand: '⏳',
  memo: '📝', pencil: '✏️', pencil2: '✏️', link: '🔗', bulb: '💡', mag: '🔍',
  exclamation: '❗', bangbang: '‼️', grey_exclamation: '❕', question: '❓', heart: '❤️',
  point_up: '☝️', point_right: '👉', arrow_right: '➡️', arrow_left: '⬅️',
  email: '📧', envelope: '✉️', mailbox: '📫', robot_face: '🤖',
  thinking_face: '🤔', joy: '😂', sob: '😭', sweat_smile: '😅',
  slightly_smiling_face: '🙂', smile: '😄', sunglasses: '😎', wink: '😉',
};

/** Turns <@U123>, <http://x|label>, and :emoji: markup into something readable. */
function flatten(text: string, names: Map<string, string>): string {
  return text
    // Prefer a name Slack embedded in the markup, then a resolved name, then the id.
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${label?.trim() || names.get(id) || id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => `#${name}`)
    // Broadcast pings: <!here>, <!channel>, <!everyone>, and <!subteam^…|@group>.
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, handle?: string) => handle?.trim() || '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, word: string) => `@${word}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, (_m, _url: string, label: string) => label)
    .replace(/<([^|>]+)>/g, (_m, url: string) => url)
    // Known shortcodes become emoji; unrecognized ones (custom/team) pass through.
    .replace(/:([a-z0-9_'+-]+):/g, (whole, code: string) => EMOJI[code] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
}

/** All user ids referenced by <@…> markup in a block of text. */
function mentionedUserIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1] as string);
}

/**
 * Resolve ids referenced in message markup to names. Person ids (U…/W…) go
 * through users.info; group ids (S…) are filled from the supplied handle map,
 * since users.info doesn't know them.
 */
async function resolveUserNames(ids: string[], groupHandles?: Map<string, string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(ids)];
  await mapLimit(
    unique.filter((id) => /^[UW]/.test(id)),
    4,
    async (id) => {
      try {
        const info = await slack<UserInfoResponse>('users.info', { user: id });
        const profile = info.user?.profile;
        names.set(id, profile?.display_name || profile?.real_name || info.user?.real_name || id);
      } catch {
        names.set(id, id);
      }
    },
  );
  // Group mentions (<@S…>) resolve from usergroups, not users.info.
  if (groupHandles) {
    for (const id of unique) {
      if (id.startsWith('S') && groupHandles.has(id)) names.set(id, groupHandles.get(id) as string);
    }
  }
  return names;
}

function excerpt(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const MENTION_WINDOW_DAYS = 7;

/** `after:` is date-granular and workspace-TZ based, so widen it by a day and
 *  trim to the exact window client-side below. */
function afterDate(days: number): string {
  const d = new Date(Date.now() - (days + 1) * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A mention is unread when it lands after the channel's `last_read` marker.
 * conversations.info returns that marker per member, so cache one lookup per
 * distinct channel rather than per mention.
 */
async function lastReadByChannel(channelIds: string[]): Promise<Map<string, string>> {
  const marks = new Map<string, string>();
  await mapLimit(channelIds, 4, async (id) => {
    try {
      const info = await slack<ConversationInfoResponse>('conversations.info', { channel: id });
      if (info.channel?.last_read) marks.set(id, info.channel.last_read);
    } catch {
      // Channels we can't inspect (e.g. not a member) stay absent -> treated as read.
    }
  });
  return marks;
}

async function searchMentions(query: string, count: string): Promise<SlackMatch[]> {
  const result = await slack<SearchResponse>('search.messages', {
    query,
    sort: 'timestamp',
    sort_dir: 'desc',
    count,
  });
  return result.messages?.matches ?? [];
}

type UserGroups = {
  /** Groups the viewer belongs to — the ones we search for mentions of. */
  mine: { handle: string }[];
  /** id -> handle for every group, to resolve <@S…> markup in message text. */
  byId: Map<string, string>;
};

/**
 * User groups (@-aliases). `include_users` returns membership in one call. Needs
 * the `usergroups:read` scope — if it's missing we return nothing so direct
 * mentions still work.
 */
async function fetchUserGroups(me: AuthResponse): Promise<UserGroups> {
  try {
    const res = await slack<UserGroupsResponse>('usergroups.list', {
      include_users: 'true',
      include_disabled: 'false',
    });
    const groups = res.usergroups ?? [];
    const byId = new Map(groups.filter((g) => g.handle).map((g) => [g.id, g.handle]));
    const mine = groups
      .filter((g) => !g.date_delete && g.handle && (g.users ?? []).includes(me.user_id))
      .map((g) => ({ handle: g.handle }));
    return { mine, byId };
  } catch (error) {
    if (error instanceof SlackApiError && error.code === 'missing_scope') return { mine: [], byId: new Map() };
    throw error;
  }
}

/** One row per message, tracking whether it was a direct ping and which aliases matched. */
type MentionHit = { match: SlackMatch; direct: boolean; aliases: Set<string> };

function matchKey(m: SlackMatch): string {
  return m.iid ?? `${m.channel?.id}-${m.ts}`;
}

async function fetchMentions(me: AuthResponse, groups: UserGroups): Promise<Item[]> {
  const count = String(config.slack.mentionLimit);
  const after = afterDate(MENTION_WINDOW_DAYS);

  // Direct pings: raw user-id token, falling back to the rendered handle.
  let direct = await searchMentions(`<@${me.user_id}> after:${after}`, count);
  if (!direct.length) direct = await searchMentions(`@${me.user} after:${after}`, count);

  // Alias pings: one search per user group the viewer is in.
  const groupResults = await mapLimit(groups.mine, 3, async (group) => ({
    handle: group.handle,
    matches: await searchMentions(`@${group.handle} after:${after}`, count),
  }));

  // Merge, deduping a message that matched several searches into one row.
  const hits = new Map<string, MentionHit>();
  const record = (m: SlackMatch, alias: string | null) => {
    const key = matchKey(m);
    const hit = hits.get(key) ?? { match: m, direct: false, aliases: new Set<string>() };
    if (alias) hit.aliases.add(alias);
    else hit.direct = true;
    hits.set(key, hit);
  };
  for (const m of direct) record(m, null);
  for (const group of groupResults) for (const m of group.matches) record(m, `@${group.handle}`);

  const cutoff = (Date.now() - MENTION_WINDOW_DAYS * 86_400_000) / 1000;
  const entries = [...hits.values()]
    .filter((h) => h.match.user !== me.user_id)
    .filter((h) => Number.parseFloat(h.match.ts) >= cutoff)
    .sort((a, b) => Number.parseFloat(b.match.ts) - Number.parseFloat(a.match.ts));

  const channelIds = [...new Set(entries.map((h) => h.match.channel?.id).filter(Boolean) as string[])];
  const [marks, names] = await Promise.all([
    lastReadByChannel(channelIds),
    resolveUserNames(entries.flatMap((h) => mentionedUserIds(h.match.text ?? '')), groups.byId),
  ]);

  return entries.map(({ match, direct: isDirect, aliases }, index): Item => {
    const channel = match.channel?.name
      ? `#${match.channel.name}`
      : match.channel?.is_im
        ? 'Direct message'
        : 'Slack';

    const lastRead = match.channel?.id ? marks.get(match.channel.id) : undefined;
    const unread = lastRead ? Number.parseFloat(match.ts) > Number.parseFloat(lastRead) : false;

    const badges: Badge[] = [];
    if (unread) badges.push({ label: 'Unread', tone: 'warn' });
    // Show which alias caught it, unless it was also a direct ping to you.
    if (!isDirect && aliases.size) badges.push({ label: [...aliases].join(', '), tone: 'neutral' });

    return {
      id: `slack:mention:${matchKey(match)}`,
      title: `${match.username ?? 'Someone'} in ${channel}`,
      url: match.permalink,
      // The channel is already in the title; repeating it just adds noise.
      excerpt: excerpt(flatten(match.text ?? '', names)),
      badges: badges.length ? badges : undefined,
      timestamp: tsToIso(match.ts),
      // Unread float to the top; both groups stay newest-first within themselves.
      rank: (unread ? 0 : 1000) + index,
      tone: unread ? 'warn' : 'muted',
    };
  });
}

async function fetchUnreadDms(me: AuthResponse, groups: UserGroups): Promise<Item[]> {
  const list = await slack<ConversationsResponse>('users.conversations', {
    types: 'im,mpim',
    exclude_archived: 'true',
    limit: String(config.slack.dmScanLimit),
  });

  const channels = list.channels ?? [];

  const unread = await mapLimit(channels, 4, async (channel) => {
    try {
      const info = await slack<ConversationInfoResponse>('conversations.info', { channel: channel.id });
      // Slack rejects some last_read values as an `oldest` arg (invalid_ts_oldest),
      // so read recent history plainly and compare timestamps ourselves.
      const lastRead = Number.parseFloat(info.channel?.last_read ?? '');
      if (!Number.isFinite(lastRead)) return null;

      const history = await slack<HistoryResponse>('conversations.history', {
        channel: channel.id,
        limit: '20',
      });

      // Skip your own replies and system messages; keep only what arrived unread.
      const messages = (history.messages ?? []).filter(
        (m) => !m.subtype && m.user !== me.user_id && Number.parseFloat(m.ts) > lastRead,
      );
      if (messages.length === 0) return null;

      const latest = messages[0];
      if (!latest) return null;
      return { channel, count: messages.length, latest };
    } catch {
      // A single unreadable conversation must not blank the whole column.
      return null;
    }
  });

  const withUnread = unread.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // Resolve names for the DM partners and anyone referenced in the latest messages.
  const names = await resolveUserNames(
    withUnread.flatMap((e) => [
      ...([e.channel.user, e.latest.user].filter(Boolean) as string[]),
      ...mentionedUserIds(e.latest.text ?? ''),
    ]),
    groups.byId,
  );

  return withUnread.map((entry): Item => {
    const who = entry.channel.user ? (names.get(entry.channel.user) ?? 'Direct message') : 'Group DM';
    return {
      id: `slack:dm:${entry.channel.id}`,
      title: who,
      url: `slack://channel?team=${me.team}&id=${entry.channel.id}`,
      context: entry.count > 1 ? `${entry.count} unread` : '1 unread',
      excerpt: excerpt(flatten(entry.latest.text ?? '', names)),
      timestamp: tsToIso(entry.latest.ts),
      rank: -entry.count,
      tone: 'warn',
    };
  });
}

export async function fetchSlack(): Promise<Section[]> {
  const mentions: Section = {
    key: 'slack-mentions',
    label: 'Slack · mentions',
    source: 'slack',
    items: [],
    emptyLabel: 'No recent mentions.',
  };
  const dms: Section = {
    key: 'slack-dms',
    label: 'Slack · unread DMs',
    source: 'slack',
    items: [],
    emptyLabel: 'No unread direct messages.',
  };

  if (!config.slack.userToken) {
    const hint = 'Set SLACK_USER_TOKEN (a user token, xoxp-…) in .env to enable.';
    return [
      { ...mentions, hint },
      { ...dms, hint },
    ];
  }

  const me = await slack<AuthResponse>('auth.test', {});
  // One usergroups lookup, shared by both mentions (for searching + resolving)
  // and DMs (for resolving group mentions in message text).
  const groups = await fetchUserGroups(me);

  const [mentionResult, dmResult] = await Promise.allSettled([
    fetchMentions(me, groups),
    fetchUnreadDms(me, groups),
  ]);

  if (mentionResult.status === 'fulfilled') mentions.items = mentionResult.value;
  else mentions.error = mentionResult.reason instanceof Error ? mentionResult.reason.message : String(mentionResult.reason);

  if (dmResult.status === 'fulfilled') dms.items = dmResult.value;
  else dms.error = dmResult.reason instanceof Error ? dmResult.reason.message : String(dmResult.reason);

  return [mentions, dms];
}
