const AUTO_REFRESH_MS = 120_000;

const board = document.getElementById('board');
const chipsEl = document.getElementById('chips');
const statusEl = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const greetingEl = document.getElementById('greeting');
const dateEl = document.getElementById('date');

const SOURCE_LABELS = {
  calendar: 'Calendar',
  slack: 'Slack',
  linear: 'Linear',
  gitlab: 'GitLab',
};

/** Sections whose counts represent things demanding a reply. */
const ALERT_SOURCES = new Set(['slack']);

/**
 * Each group becomes one column, so a source's cards stack vertically together
 * instead of being scattered across a row. Sections from a source not listed
 * here fall into the first column rather than disappearing.
 */
const COLUMN_GROUPS = [
  { key: 'day', sources: ['calendar', 'linear'] },
  { key: 'slack', sources: ['slack'] },
  { key: 'gitlab', sources: ['gitlab'] },
];

let lastGeneratedAt = null;

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const future = diffMs < 0;
  const seconds = Math.round(Math.abs(diffMs) / 1000);
  const units = [
    ['s', 60],
    ['m', 60],
    ['h', 24],
    ['d', 7],
    ['w', 52],
  ];
  let value = seconds;
  let unit = 's';
  for (const [suffix, size] of units) {
    unit = suffix;
    if (value < size) break;
    value = Math.round(value / size);
  }
  if (unit === 's' && value < 45) return future ? 'soon' : 'just now';
  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 12-hour clock in the viewer's own timezone (no explicit timeZone = system default). */
function formatClock(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** The time text shown on an item, always resolved in the viewer's timezone. */
function timeLabelFor(item) {
  if (item.allDay) return 'All day';
  if (item.timestamp && item.endTimestamp) return `${formatClock(item.timestamp)} – ${formatClock(item.endTimestamp)}`;
  if (item.timeLabel) return item.timeLabel;
  return item.timestamp ? relativeTime(item.timestamp) : '';
}

function renderItem(item) {
  const node = el(item.url ? 'a' : 'div', `item item--${item.tone ?? 'neutral'}`);
  if (item.url) {
    node.href = item.url;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }

  const row = el('div', 'item__row');
  row.append(el('span', 'item__title', item.title));

  const timeText = timeLabelFor(item);
  if (timeText) row.append(el('span', 'item__time', timeText));
  node.append(row);

  if (item.excerpt) node.append(el('div', 'item__excerpt', item.excerpt));

  const badges = item.badges ?? [];
  if (item.context || badges.length) {
    const meta = el('div', 'item__meta');
    if (item.context) meta.append(el('span', 'item__context', item.context));
    for (const badge of badges) {
      meta.append(el('span', `badge badge--${badge.tone ?? 'neutral'}`, badge.label));
    }
    node.append(meta);
  }

  return node;
}

function renderSection(section) {
  const card = el('section', 'card');
  card.id = `section-${section.key}`;
  card.dataset.source = section.source;

  const head = el('div', 'card__head');
  head.append(el('h2', 'card__title', section.label));
  if (section.items.length) head.append(el('span', 'card__count', String(section.items.length)));
  card.append(head);

  if (section.error) {
    card.append(el('p', 'card__note card__note--error', section.error));
  } else if (section.hint && section.items.length) {
    card.append(el('p', 'card__note', section.hint));
  }

  if (section.items.length) {
    // When capped, items live in a scroll container we height-limit after layout.
    const host = section.maxVisible ? el('div', 'card__scroll') : card;
    for (const item of section.items) host.append(renderItem(item));
    if (host !== card) {
      if (section.items.length > section.maxVisible) host.dataset.maxVisible = String(section.maxVisible);
      card.append(host);
    }
  } else if (!section.error) {
    card.append(el('p', 'card__empty', section.hint ?? section.emptyLabel ?? 'Nothing here.'));
  }

  return card;
}

/**
 * Cap each scroll container to exactly N rows. Row heights vary (excerpts wrap),
 * so measure the top of row N+1 rather than guessing a pixel height.
 */
function capScrollSections() {
  for (const host of board.querySelectorAll('.card__scroll[data-max-visible]')) {
    const max = Number(host.dataset.maxVisible);
    const rows = host.children;
    if (rows.length > max) {
      const cut = rows[max].offsetTop - host.firstElementChild.offsetTop;
      host.style.maxHeight = `${cut}px`;
    } else {
      host.style.maxHeight = '';
    }
  }
}

function renderChips(sections) {
  chipsEl.replaceChildren();
  const bySource = new Map();

  for (const section of sections) {
    const entry = bySource.get(section.source) ?? { count: 0, anchor: section.key, issues: false };
    entry.count += section.items.length;
    if (section.error) entry.issues = true;
    bySource.set(section.source, entry);
  }

  for (const [source, entry] of bySource) {
    const chip = el('a', `chip${ALERT_SOURCES.has(source) && entry.count ? ' chip--alert' : ''}`);
    chip.dataset.source = source;
    chip.href = `#section-${entry.anchor}`;
    chip.append(el('span', null, SOURCE_LABELS[source] ?? source));
    chip.append(el('span', 'chip__count', entry.issues ? '!' : String(entry.count)));
    chipsEl.append(chip);
  }
}

function updateTitle(sections) {
  const actionable = sections
    .filter((section) => section.source !== 'calendar')
    .reduce((total, section) => total + section.items.length, 0);
  document.title = actionable ? `(${actionable}) Today` : 'Today';
}

/** Buckets sections into their column, preserving the server's ordering. */
function groupIntoColumns(sections) {
  const columns = COLUMN_GROUPS.map((group) => ({ key: group.key, sections: [] }));
  const indexBySource = new Map();
  COLUMN_GROUPS.forEach((group, index) => {
    for (const source of group.sources) indexBySource.set(source, index);
  });

  for (const section of sections) {
    const index = indexBySource.get(section.source) ?? 0;
    columns[index].sections.push(section);
  }

  return columns.filter((column) => column.sections.length > 0);
}

function render(brief) {
  // The board rebuild detaches the reminders card; remember caret/focus so an
  // auto-refresh never interrupts typing.
  const typing = document.activeElement === reminderInput;
  const caret = typing ? [reminderInput.selectionStart, reminderInput.selectionEnd] : null;

  board.replaceChildren();
  const columns = groupIntoColumns(brief.sections);
  for (const column of columns) {
    const node = el('div', 'column');
    for (const section of column.sections) node.append(renderSection(section));
    board.append(node);
  }
  board.setAttribute('aria-busy', 'false');
  mountReminders();
  capScrollSections();

  if (typing && reminderInput) {
    reminderInput.focus();
    if (caret) reminderInput.setSelectionRange(caret[0], caret[1]);
  }
  renderChips(brief.sections);
  updateTitle(brief.sections);
  lastGeneratedAt = brief.generatedAt;
  setStatus();
}

// ---- Reminders (the one widget you write to, not read from an API) ----------

/** Built once and reused, so the input keeps its value across board refreshes. */
let remindersCard = null;
let reminderInput = null;
let reminderListEl = null;
let reminderCountEl = null;
let reminders = [];

function buildRemindersCard() {
  const card = el('section', 'card');
  card.dataset.source = 'reminders';

  const head = el('div', 'card__head');
  head.append(el('h2', 'card__title', 'Reminders'));
  reminderCountEl = el('span', 'card__count');
  head.append(reminderCountEl);
  card.append(head);

  const form = el('form', 'reminder-add');
  reminderInput = el('input');
  reminderInput.type = 'text';
  reminderInput.placeholder = 'Add a reminder…';
  reminderInput.maxLength = 500;
  reminderInput.setAttribute('aria-label', 'Add a reminder');

  const addButton = el('button', 'reminder-add__btn', '+');
  addButton.type = 'submit';
  addButton.setAttribute('aria-label', 'Add reminder');

  form.append(reminderInput, addButton);

  const submit = async () => {
    const text = reminderInput.value.trim();
    if (!text) return;
    reminderInput.value = '';
    await createReminder(text);
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  // Belt and braces: some environments don't fire form submit on Enter for a lone input.
  reminderInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
  card.append(form);

  reminderListEl = el('div', 'reminder-list');
  card.append(reminderListEl);

  return card;
}

/** Keep the reminders card pinned to the top of the first column (create one if the board is empty). */
function mountReminders() {
  if (!remindersCard) remindersCard = buildRemindersCard();
  let firstColumn = board.querySelector('.column');
  if (!firstColumn) {
    firstColumn = el('div', 'column');
    board.append(firstColumn);
  }
  firstColumn.prepend(remindersCard);
  renderReminderList();
}

function renderReminderList() {
  if (!reminderListEl) return; // card not built yet; mountReminders() will call again
  const active = reminders.filter((r) => !r.done);
  const done = reminders.filter((r) => r.done);
  reminderCountEl.textContent = active.length ? String(active.length) : '';
  reminderCountEl.hidden = active.length === 0;

  reminderListEl.replaceChildren();
  if (reminders.length === 0) {
    reminderListEl.append(el('p', 'card__empty', 'Nothing yet — jot something above.'));
    return;
  }
  // Active first (oldest at top so it nags), completed dimmed at the bottom.
  for (const reminder of [...active, ...done]) {
    reminderListEl.append(renderReminder(reminder));
  }
}

function renderReminder(reminder) {
  const row = el('div', `reminder${reminder.done ? ' reminder--done' : ''}`);

  const check = el('button', 'reminder__check');
  check.type = 'button';
  check.setAttribute('aria-label', reminder.done ? 'Mark as not done' : 'Mark as done');
  check.setAttribute('aria-pressed', String(reminder.done));
  check.textContent = reminder.done ? '✓' : '';
  check.addEventListener('click', () => toggleReminder(reminder));

  const text = el('span', 'reminder__text', reminder.text);

  const del = el('button', 'reminder__del', '×');
  del.type = 'button';
  del.setAttribute('aria-label', 'Delete reminder');
  del.addEventListener('click', () => removeReminder(reminder));

  row.append(check, text, del);
  return row;
}

async function loadReminders() {
  try {
    const response = await fetch('/api/reminders');
    if (!response.ok) throw new Error(`server responded ${response.status}`);
    reminders = await response.json();
    renderReminderList();
  } catch {
    // Leave whatever is on screen; the brief's own status line reports outages.
  }
}

async function createReminder(text) {
  // Optimistic: show it immediately, reconcile with the server's copy.
  const temp = { id: `tmp_${Date.now()}`, text, done: false, createdAt: new Date().toISOString() };
  reminders = [...reminders, temp];
  renderReminderList();
  try {
    const response = await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error();
    await loadReminders();
  } catch {
    reminders = reminders.filter((r) => r.id !== temp.id);
    renderReminderList();
  }
}

async function toggleReminder(reminder) {
  const done = !reminder.done;
  reminders = reminders.map((r) => (r.id === reminder.id ? { ...r, done } : r));
  renderReminderList();
  try {
    await fetch(`/api/reminders/${reminder.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
  } catch {
    await loadReminders();
  }
}

async function removeReminder(reminder) {
  reminders = reminders.filter((r) => r.id !== reminder.id);
  renderReminderList();
  try {
    await fetch(`/api/reminders/${reminder.id}`, { method: 'DELETE' });
  } catch {
    await loadReminders();
  }
}

function setStatus(message) {
  if (message) {
    statusEl.textContent = message;
    return;
  }
  statusEl.textContent = lastGeneratedAt ? `updated ${relativeTime(lastGeneratedAt)}` : '';
}

async function load({ force = false } = {}) {
  refreshButton.disabled = true;
  setStatus(force ? 'refreshing…' : 'loading…');
  try {
    const response = await fetch(`/api/brief${force ? '?refresh=1' : ''}`);
    if (!response.ok) throw new Error(`server responded ${response.status}`);
    render(await response.json());
  } catch (error) {
    board.setAttribute('aria-busy', 'false');
    setStatus(`failed: ${error.message}`);
    if (!board.querySelector('.card')) {
      board.replaceChildren(el('p', 'placeholder', `Could not reach the dashboard server: ${error.message}`));
    }
    // Reminders are local, so keep them usable even when the brief can't load.
    mountReminders();
  } finally {
    refreshButton.disabled = false;
  }
}

greetingEl.textContent = greeting();
dateEl.textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

refreshButton.addEventListener('click', () => load({ force: true }));

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'r') load({ force: true });
});

// Coming back to the tab should show something current, not this morning's state.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

// Row heights change when the column width changes; re-measure the caps.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(capScrollSections, 150);
});

setInterval(() => load({ force: true }), AUTO_REFRESH_MS);
setInterval(setStatus, 30_000);
load();
loadReminders();
