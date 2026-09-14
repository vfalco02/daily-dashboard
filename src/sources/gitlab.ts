import { config } from '../config.js';
import { requestJson } from '../http.js';
import type { Badge, Item, Section } from '../types.js';

type GitLabUser = { id: number; username: string };

type GitLabMr = {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  updated_at: string;
  created_at: string;
  user_notes_count?: number;
  source_branch: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  blocking_discussions_resolved?: boolean;
  author: { username: string };
  references?: { full?: string };
  reviewers?: GitLabUser[];
};

async function gitlabGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`/api/v4${path}`, config.gitlab.host);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return requestJson<T>('GitLab', url.toString(), {
    headers: { 'PRIVATE-TOKEN': config.gitlab.token as string },
  });
}

const AGE_WARN_DAYS = 7;

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function toItem(mr: GitLabMr, kind: 'authored' | 'review'): Item {
  const badges: Badge[] = [];
  const isDraft = mr.draft ?? mr.work_in_progress ?? false;
  if (isDraft) badges.push({ label: 'Draft', tone: 'muted' });
  if (mr.has_conflicts) badges.push({ label: 'Conflicts', tone: 'urgent' });
  if (mr.blocking_discussions_resolved === false) {
    badges.push({ label: 'Unresolved threads', tone: 'warn' });
  }
  if (mr.user_notes_count) badges.push({ label: `${mr.user_notes_count} comments`, tone: 'neutral' });

  const age = ageDays(mr.created_at);
  if (age >= AGE_WARN_DAYS) badges.push({ label: `Open ${age}d`, tone: 'warn' });
  if (kind === 'review') badges.push({ label: `@${mr.author.username}`, tone: 'neutral' });

  const stale = ageDays(mr.updated_at) >= AGE_WARN_DAYS;

  return {
    id: `gitlab:${mr.id}`,
    title: `!${mr.iid} · ${mr.title.replace(/^(Draft|WIP):\s*/i, '')}`,
    url: mr.web_url,
    context: mr.references?.full?.split('!')[0] ?? mr.source_branch,
    badges,
    timestamp: mr.updated_at,
    // Review requests that have sat the longest are the ones blocking someone.
    rank: kind === 'review' ? -age : isDraft ? 100 : -age,
    tone: mr.has_conflicts ? 'urgent' : stale ? 'warn' : isDraft ? 'muted' : 'neutral',
  };
}

export async function fetchGitlab(): Promise<Section[]> {
  const authored: Section = {
    key: 'gitlab-authored',
    label: 'GitLab · your open MRs',
    source: 'gitlab',
    items: [],
    emptyLabel: 'No open merge requests of your own.',
  };
  const review: Section = {
    key: 'gitlab-review',
    label: 'GitLab · waiting on your review',
    source: 'gitlab',
    items: [],
    emptyLabel: 'Nothing waiting on your review.',
  };

  if (!config.gitlab.token) {
    const hint = 'Set GITLAB_TOKEN (and GITLAB_HOST for self-managed) in .env to enable.';
    return [
      { ...authored, hint },
      { ...review, hint },
    ];
  }

  const me = await gitlabGet<GitLabUser>('/user', {});

  const [mine, toReview] = await Promise.all([
    gitlabGet<GitLabMr[]>('/merge_requests', {
      scope: 'created_by_me',
      state: 'opened',
      order_by: 'updated_at',
      per_page: '50',
    }),
    gitlabGet<GitLabMr[]>('/merge_requests', {
      scope: 'all',
      state: 'opened',
      reviewer_id: String(me.id),
      order_by: 'updated_at',
      per_page: '50',
    }),
  ]);

  authored.items = mine.map((mr) => toItem(mr, 'authored'));
  // GitLab happily returns your own MRs here if you added yourself as reviewer.
  review.items = toReview.filter((mr) => mr.author.username !== me.username).map((mr) => toItem(mr, 'review'));

  return [review, authored];
}
