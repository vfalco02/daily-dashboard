import ical from 'node-ical';
import { config } from '../config.js';
import type { Badge, Item, Section, Tone } from '../types.js';

type Occurrence = {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  url?: string;
};

const DAY_MS = 86_400_000;

function dayBounds(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Pulls a joinable meeting link out of the fields Google tends to use. */
function meetingLink(event: ical.VEvent): string | undefined {
  const candidates = [
    (event as { 'X-GOOGLE-CONFERENCE'?: string })['X-GOOGLE-CONFERENCE'],
    typeof event.location === 'string' ? event.location : undefined,
    typeof event.description === 'string' ? event.description : undefined,
  ];
  for (const candidate of candidates) {
    const match = candidate?.match(/https?:\/\/[^\s>"']*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)[^\s>"']*/i);
    if (match) return match[0];
  }
  return undefined;
}

function declined(event: ical.VEvent): boolean {
  if (!config.calendar.email) return false;
  const raw = (event as { attendee?: unknown }).attendee;
  const attendees = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return attendees.some((attendee) => {
    const record = attendee as { val?: string; params?: { PARTSTAT?: string; CN?: string } };
    const address = String(record?.val ?? '').toLowerCase().replace('mailto:', '');
    return address === config.calendar.email && record?.params?.PARTSTAT === 'DECLINED';
  });
}

/**
 * rrule expansion is timezone-naive: each occurrence comes back with the event's
 * wall-clock time stamped onto the UTC fields (an 11:30 local meeting arrives as
 * 11:30Z). Reinterpret those clock fields as local time to recover the true
 * instant. Because rrule projects the same wall-clock time onto every date, this
 * also lands DST correctly — an 11:30 meeting stays 11:30 across the switch.
 */
function occurrenceToLocal(occurrence: Date): Date {
  return new Date(
    occurrence.getUTCFullYear(),
    occurrence.getUTCMonth(),
    occurrence.getUTCDate(),
    occurrence.getUTCHours(),
    occurrence.getUTCMinutes(),
    occurrence.getUTCSeconds(),
    occurrence.getUTCMilliseconds(),
  );
}

function expand(event: ical.VEvent, windowStart: Date, windowEnd: Date): Occurrence[] {
  if (event.status === 'CANCELLED' || declined(event)) return [];

  const allDay = (event as { datetype?: string }).datetype === 'date';
  const durationMs = Math.max(event.end.getTime() - event.start.getTime(), 0);
  const base = {
    uid: event.uid,
    summary: event.summary || '(no title)',
    allDay,
    location: typeof event.location === 'string' && event.location ? event.location : undefined,
    url: meetingLink(event),
  };

  const rrule = (event as { rrule?: { between(a: Date, b: Date, inc: boolean): Date[] } }).rrule;
  if (!rrule) {
    if (event.end <= windowStart || event.start >= windowEnd) return [];
    return [{ ...base, start: event.start, end: event.end }];
  }

  // Widen the search so long meetings that started yesterday still surface.
  const dates = rrule.between(new Date(windowStart.getTime() - DAY_MS), windowEnd, true);
  const exdates = (event as { exdate?: Record<string, Date> }).exdate ?? {};
  const overrides = (event as { recurrences?: Record<string, ical.VEvent> }).recurrences ?? {};

  const occurrences: Occurrence[] = [];
  for (const date of dates) {
    const key = date.toISOString().slice(0, 10);
    if (exdates[key]) continue;

    const override = overrides[key];
    if (override) {
      if (override.status === 'CANCELLED' || declined(override)) continue;
      if (override.end > windowStart && override.start < windowEnd) {
        occurrences.push({
          ...base,
          summary: override.summary || base.summary,
          start: override.start,
          end: override.end,
          url: meetingLink(override) ?? base.url,
        });
      }
      continue;
    }

    const start = occurrenceToLocal(date);
    const end = new Date(start.getTime() + durationMs);
    if (end > windowStart && start < windowEnd) occurrences.push({ ...base, start, end });
  }
  return occurrences;
}

function toItem(occurrence: Occurrence, now: Date): Item {
  const badges: Badge[] = [];
  let tone: Tone = 'neutral';

  // Times are rendered by the browser (see app.js) so they always show in the
  // viewer's own timezone, regardless of where this process runs. Only the
  // absolute now-relative state (Now / In Xm) is decided here.
  if (occurrence.allDay) {
    tone = 'muted';
  } else {
    const minutesUntil = Math.round((occurrence.start.getTime() - now.getTime()) / 60_000);
    if (now >= occurrence.start && now < occurrence.end) {
      badges.push({ label: 'Now', tone: 'urgent' });
      tone = 'urgent';
    } else if (minutesUntil > 0 && minutesUntil <= 30) {
      badges.push({ label: `In ${minutesUntil}m`, tone: 'warn' });
      tone = 'warn';
    } else if (occurrence.end <= now) {
      tone = 'muted';
    }
  }

  if (occurrence.url) badges.push({ label: 'Join', tone: 'ok' });

  return {
    id: `calendar:${occurrence.uid}:${occurrence.start.toISOString()}`,
    title: occurrence.summary,
    url: occurrence.url,
    context: occurrence.location && !occurrence.location.startsWith('http') ? occurrence.location : undefined,
    badges,
    timestamp: occurrence.start.toISOString(),
    endTimestamp: occurrence.end.toISOString(),
    allDay: occurrence.allDay,
    rank: occurrence.allDay ? -1 : occurrence.start.getTime(),
    tone,
  };
}

export async function fetchCalendar(): Promise<Section[]> {
  const section: Section = {
    key: 'calendar-today',
    label: 'Calendar · today',
    source: 'calendar',
    items: [],
    emptyLabel: 'Nothing on the calendar today.',
  };

  if (!config.calendar.icsUrl) {
    return [{ ...section, hint: 'Set GOOGLE_CALENDAR_ICS_URL (Google Calendar → Settings → secret iCal address) in .env to enable.' }];
  }

  const now = new Date();
  const { start, end } = dayBounds(now);
  const data = await ical.async.fromURL(config.calendar.icsUrl);

  const occurrences = Object.values(data)
    .filter((entry): entry is ical.VEvent => (entry as ical.VEvent)?.type === 'VEVENT')
    .flatMap((event) => expand(event, start, end));

  section.items = occurrences.map((occurrence) => toItem(occurrence, now));
  return [section];
}
