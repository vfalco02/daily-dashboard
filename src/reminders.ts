import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { projectRoot } from './config.js';

export type Reminder = {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
};

// A plain JSON file next to the app: survives restarts and cache clears, and is
// trivial to back up or edit by hand. Gitignored — reminders are personal.
const file = resolve(projectRoot, 'data/reminders.json');

function load(): Reminder[] {
  try {
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Reminder[]) : [];
  } catch {
    return [];
  }
}

function save(items: Reminder[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(items, null, 2));
}

function newId(): string {
  return `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function listReminders(): Reminder[] {
  return load();
}

export function addReminder(text: string): Reminder {
  const items = load();
  const reminder: Reminder = { id: newId(), text, done: false, createdAt: new Date().toISOString() };
  items.push(reminder);
  save(items);
  return reminder;
}

export function updateReminder(id: string, patch: { done?: boolean; text?: string }): Reminder | null {
  const items = load();
  const item = items.find((r) => r.id === id);
  if (!item) return null;
  if (typeof patch.done === 'boolean') item.done = patch.done;
  if (typeof patch.text === 'string' && patch.text.trim()) item.text = patch.text.trim();
  save(items);
  return item;
}

export function deleteReminder(id: string): boolean {
  const items = load();
  const next = items.filter((r) => r.id !== id);
  if (next.length === items.length) return false;
  save(next);
  return true;
}
