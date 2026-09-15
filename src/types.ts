/** A single actionable thing on your plate, normalised across every source. */
export type Item = {
  id: string;
  title: string;
  url?: string;
  /** Where it lives: project name, repo path, channel. */
  context?: string;
  /** Small pills rendered next to the title. */
  badges?: Badge[];
  /** ISO timestamp used for sorting and the relative-time label. */
  timestamp?: string;
  /** Overrides the relative-time label (e.g. "09:30 – 10:00" for meetings). */
  timeLabel?: string;
  /** ISO end time; with `timestamp` it renders as a clock range in the viewer's timezone. */
  endTimestamp?: string;
  /** All-day event — renders "All day" instead of a clock range. */
  allDay?: boolean;
  /** Sort key, ascending. Lower floats to the top within a section. */
  rank?: number;
  /** Drives the colour of the left edge marker. */
  tone?: Tone;
  /** Free-text line under the title, e.g. a message excerpt. */
  excerpt?: string;
};

export type Tone = 'urgent' | 'warn' | 'ok' | 'muted' | 'neutral';

export type Badge = {
  label: string;
  tone?: Tone;
};

export type Section = {
  key: string;
  label: string;
  /** Which integration produced it, used for grouping and the source filter. */
  source: SourceKey;
  items: Item[];
  /** Set when the source is not configured; the section renders as a hint. */
  hint?: string;
  /** Set when the fetch blew up; the section renders the failure. */
  error?: string;
  /** Message shown when the section fetched fine but has nothing in it. */
  emptyLabel?: string;
  /** Cap the visible rows to this many; the rest scroll within the card. */
  maxVisible?: number;
};

export type SourceKey = 'linear' | 'gitlab' | 'slack' | 'calendar';

export type Brief = {
  generatedAt: string;
  durationMs: number;
  sections: Section[];
};
