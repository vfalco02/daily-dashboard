/** Thrown when an upstream API answers with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${service} responded ${status}: ${summarise(body)}`);
    this.name = 'ApiError';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Error bodies are usually JSON wrapping one useful sentence. Dig it out rather
 * than printing a wall of envelope fields.
 */
function summarise(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const found = findMessage(parsed, 0);
    if (found) return truncate(found, 200);
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return truncate(body.trim().replace(/\s+/g, ' '), 200) || '(empty response)';
}

function findMessage(value: unknown, depth: number): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findMessage(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['userPresentableMessage', 'message', 'error_description', 'error', 'detail']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const nested of Object.values(record)) {
    const found = findMessage(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function requestJson<T>(
  service: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new ApiError(service, response.status, await response.text().catch(() => ''));
  }
  return (await response.json()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Request timed out';
    return error.message;
  }
  return String(error);
}

/** Runs tasks with bounded concurrency so we never flood an API. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
