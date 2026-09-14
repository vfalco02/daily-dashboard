import { config } from '../config.js';
import { requestJson } from '../http.js';
import type { Badge, Item, Section, Tone } from '../types.js';

type LinearIssue = {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  updatedAt: string;
  dueDate: string | null;
  branchName: string | null;
  state: { name: string; type: string };
  project: { name: string } | null;
  team: { key: string } | null;
};

type LinearResponse = {
  data?: { viewer: { name: string; assignedIssues: { nodes: LinearIssue[] } } };
  errors?: { message: string }[];
};

const QUERY = `
  query AssignedIssues {
    viewer {
      name
      assignedIssues(
        first: 50
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
        orderBy: updatedAt
      ) {
        nodes {
          identifier
          title
          url
          priority
          updatedAt
          dueDate
          branchName
          state { name type }
          project { name }
          team { key }
        }
      }
    }
  }
`;

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

function priorityTone(priority: number): Tone {
  if (priority === 1) return 'urgent';
  if (priority === 2) return 'warn';
  return 'muted';
}

function dueBadge(dueDate: string | null): Badge | undefined {
  if (!dueDate) return undefined;
  const due = new Date(`${dueDate}T23:59:59`);
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: `Overdue ${Math.abs(days)}d`, tone: 'urgent' };
  if (days === 0) return { label: 'Due today', tone: 'urgent' };
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'warn' };
  return { label: `Due ${dueDate}`, tone: 'muted' };
}

/** In-progress work sorts above everything else, then by priority. */
function rankOf(issue: LinearIssue): number {
  const stateWeight = issue.state.type === 'started' ? 0 : issue.state.type === 'unstarted' ? 100 : 200;
  const priority = issue.priority === 0 ? 5 : issue.priority;
  return stateWeight + priority;
}

export async function fetchLinear(): Promise<Section[]> {
  const section: Section = {
    key: 'linear-assigned',
    label: 'Linear · assigned to you',
    source: 'linear',
    items: [],
    emptyLabel: 'No open issues assigned to you.',
  };

  if (!config.linear.apiKey) {
    return [{ ...section, hint: 'Set LINEAR_API_KEY in .env to enable.' }];
  }

  const payload = await requestJson<LinearResponse>('Linear', 'https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: config.linear.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: QUERY }),
  });

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }

  const issues = payload.data?.viewer.assignedIssues.nodes ?? [];
  section.items = issues.map((issue): Item => {
    const badges: Badge[] = [{ label: issue.state.name, tone: issue.state.type === 'started' ? 'ok' : 'neutral' }];
    if (issue.priority > 0) {
      badges.push({
        label: PRIORITY_LABELS[issue.priority] ?? `P${issue.priority}`,
        tone: priorityTone(issue.priority),
      });
    }
    const due = dueBadge(issue.dueDate);
    if (due) badges.push(due);

    return {
      id: `linear:${issue.identifier}`,
      title: `${issue.identifier} · ${issue.title}`,
      url: issue.url,
      context: issue.project?.name ?? issue.team?.key ?? undefined,
      badges,
      timestamp: issue.updatedAt,
      rank: rankOf(issue),
      tone: issue.priority === 1 ? 'urgent' : issue.state.type === 'started' ? 'ok' : 'neutral',
    };
  });

  return [section];
}
