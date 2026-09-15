const AUTO_REFRESH_MS = 120_000;

const board = document.getElementById('board');
const chipsEl = document.getElementById('chips');
const statusEl = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const settingsButton = document.getElementById('settings');
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

const NUM_COLUMNS = 3;

// ---- Draggable layout -------------------------------------------------------
// The card arrangement is a per-viewer preference, so it lives in localStorage:
// an array of NUM_COLUMNS arrays of card keys.

const LAYOUT_KEY = 'dashboard.layout.v1';

function loadLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveLayout(columns) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(columns));
  } catch {
    // Private mode or blocked storage — arrangement just won't persist.
  }
}

/** Default column for a card whose key isn't in the saved layout (new source, first run). */
function defaultColumnIndex(source) {
  if (source === 'reminders') return 0;
  const index = COLUMN_GROUPS.findIndex((group) => group.sources.includes(source));
  return index >= 0 ? index : 0;
}

/** Order cards into NUM_COLUMNS columns: saved layout first, then any newcomers by default. */
function computeColumns(cards) {
  const byKey = new Map(cards.map((card) => [card.key, card]));
  const columns = Array.from({ length: NUM_COLUMNS }, () => []);
  const placed = new Set();

  const saved = loadLayout();
  if (Array.isArray(saved)) {
    saved.slice(0, NUM_COLUMNS).forEach((keys, i) => {
      if (!Array.isArray(keys)) return;
      for (const key of keys) {
        if (byKey.has(key) && !placed.has(key)) {
          columns[i].push(byKey.get(key));
          placed.add(key);
        }
      }
    });
  }

  for (const card of cards) {
    if (placed.has(card.key)) continue;
    columns[defaultColumnIndex(card.source)].push(card);
    placed.add(card.key);
  }
  return columns;
}

/** Read the current DOM arrangement back into a layout and persist it. */
function persistLayout() {
  const columns = [...board.querySelectorAll(':scope > .column')].map((col) =>
    [...col.querySelectorAll(':scope > .card')].map((card) => card.dataset.key).filter(Boolean),
  );
  saveLayout(columns);
}

/** Empty columns collapse, except while dragging when they show as drop targets. */
function markEmptyColumns() {
  for (const col of board.querySelectorAll(':scope > .column')) {
    col.classList.toggle('column--empty', col.querySelector(':scope > .card') == null);
  }
}

// ---- Collapsible cards ------------------------------------------------------
// Which cards are collapsed is a per-viewer preference, stored as a list of keys.

const COLLAPSED_KEY = 'dashboard.collapsed.v1';

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // Non-persistent storage — collapse still works for the session.
  }
}

const collapsed = loadCollapsed();

// ---- Show/hide sources (top-bar pills) --------------------------------------

const HIDDEN_KEY = 'dashboard.hidden.v1';

function loadHidden() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveHidden(set) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
  } catch {
    // Non-persistent storage — hiding still works for the session.
  }
}

const hiddenSources = loadHidden();
let lastBrief = null;

function toggleSource(source) {
  if (hiddenSources.has(source)) hiddenSources.delete(source);
  else hiddenSources.add(source);
  saveHidden(hiddenSources);
  if (lastBrief) render(lastBrief);
}

/** Wire a header's chevron (and header clicks) to collapse/expand the card by key. */
function attachCollapse(card, head, key) {
  const chevron = el('button', 'card__collapse', '▾');
  chevron.type = 'button';
  chevron.setAttribute('aria-label', 'Collapse or expand section');
  head.append(chevron);

  const apply = () => {
    const isCollapsed = collapsed.has(key);
    card.classList.toggle('card--collapsed', isCollapsed);
    chevron.setAttribute('aria-expanded', String(!isCollapsed));
  };
  const toggle = () => {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveCollapsed(collapsed);
    apply();
    capScrollSections(); // a re-expanded list needs its height cap recomputed
  };

  chevron.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  head.addEventListener('click', (event) => {
    // Header clicks toggle too, except when grabbing the drag handle.
    if (event.target.closest('.card__grip')) return;
    toggle();
  });

  apply();
}

let draggedCard = null;

/** A grip in the card header that arms dragging (so links/scroll still work elsewhere). */
function makeGrip(card) {
  const grip = el('button', 'card__grip', '⠿');
  grip.type = 'button';
  grip.title = 'Drag to move';
  grip.setAttribute('aria-label', 'Drag to move card');
  grip.addEventListener('mousedown', () => {
    card.draggable = true;
  });
  grip.addEventListener('click', (event) => event.preventDefault());
  return grip;
}

function attachCardDrag(card) {
  card.addEventListener('dragstart', (event) => {
    draggedCard = card;
    card.classList.add('dragging');
    board.classList.add('board--dragging');
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', card.dataset.key || '');
    } catch {
      // Some browsers are picky about setData; the drag still works without it.
    }
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    card.draggable = false;
    board.classList.remove('board--dragging');
    draggedCard = null;
    markEmptyColumns();
    persistLayout();
  });
  // A grip press that didn't become a drag shouldn't leave the card armed.
  card.addEventListener('mouseup', () => {
    card.draggable = false;
  });
}

/** The card the dragged one should be inserted before, by vertical midpoint. */
function dragAfterElement(column, y) {
  const cards = [...column.querySelectorAll(':scope > .card:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

function attachColumnDrop(column) {
  column.addEventListener('dragover', (event) => {
    if (!draggedCard) return;
    event.preventDefault();
    const after = dragAfterElement(column, event.clientY);
    if (after == null) column.append(draggedCard);
    else column.insertBefore(draggedCard, after);
    markEmptyColumns();
  });
}

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
  card.dataset.key = section.key;

  const head = el('div', 'card__head');
  head.append(makeGrip(card));
  head.append(el('h2', 'card__title', section.label));
  if (section.items.length) head.append(el('span', 'card__count', String(section.items.length)));
  card.append(head);
  attachCardDrag(card);
  attachCollapse(card, head, section.key);

  if (section.error) {
    card.append(el('p', 'card__note card__note--error', section.error));
  } else if (section.hint && section.items.length) {
    card.append(el('p', 'card__note', section.hint));
  }

  if (section.items.length) {
    // Per-source cap from settings; when set, items live in a scroll container
    // we height-limit after layout.
    const cap = rowCaps[section.source] || 0;
    const host = cap ? el('div', 'card__scroll') : card;
    for (const item of section.items) host.append(renderItem(item));
    if (host !== card) {
      if (section.items.length > cap) host.dataset.maxVisible = String(cap);
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
  for (const host of board.querySelectorAll('[data-max-visible]')) {
    if (host.offsetParent === null) continue; // inside a collapsed card; nothing to measure
    const max = Number(host.dataset.maxVisible);
    const rows = host.children;
    if (max > 0 && rows.length > max) {
      const cut = rows[max].offsetTop - host.firstElementChild.offsetTop;
      host.style.maxHeight = `${cut}px`;
      host.style.overflowY = 'auto';
    } else {
      host.style.maxHeight = '';
      host.style.overflowY = '';
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
    const hidden = hiddenSources.has(source);
    const alert = ALERT_SOURCES.has(source) && entry.count && !hidden;
    const chip = el('button', `chip${hidden ? ' chip--off' : ''}${alert ? ' chip--alert' : ''}`);
    chip.type = 'button';
    chip.dataset.source = source;
    chip.setAttribute('aria-pressed', String(!hidden));
    chip.title = hidden ? `Show ${SOURCE_LABELS[source] ?? source}` : `Hide ${SOURCE_LABELS[source] ?? source}`;
    chip.append(el('span', null, SOURCE_LABELS[source] ?? source));
    chip.append(el('span', 'chip__count', entry.issues ? '!' : String(entry.count)));
    chip.addEventListener('click', () => toggleSource(source));
    chipsEl.append(chip);
  }
}

function updateTitle(sections) {
  const actionable = sections
    .filter((section) => section.source !== 'calendar')
    .reduce((total, section) => total + section.items.length, 0);
  document.title = actionable ? `(${actionable}) Today` : 'Today';
}

function render(brief) {
  // The board rebuild detaches the reminders card; remember caret/focus so an
  // auto-refresh never interrupts typing.
  const typing = document.activeElement === reminderInput;
  const caret = typing ? [reminderInput.selectionStart, reminderInput.selectionEnd] : null;

  lastBrief = brief;
  rowCaps = brief.rows || {};

  // Reminders is a draggable card like any other; it just uses the persistent node.
  // Sources toggled off via the top-bar pills are left out of the board.
  const cards = [
    { key: 'reminders', source: 'reminders', el: ensureRemindersCard() },
    ...brief.sections
      .filter((section) => !hiddenSources.has(section.source))
      .map((section) => ({ key: section.key, source: section.source, el: renderSection(section) })),
  ];

  board.replaceChildren();
  for (const colCards of computeColumns(cards)) {
    const colEl = el('div', 'column');
    for (const card of colCards) colEl.append(card.el);
    attachColumnDrop(colEl);
    board.append(colEl);
  }
  markEmptyColumns();
  board.setAttribute('aria-busy', 'false');

  renderReminderList();
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

/** Per-source row caps from the latest brief (0 = show all). */
let rowCaps = {};

function buildRemindersCard() {
  const card = el('section', 'card');
  card.dataset.source = 'reminders';
  card.dataset.key = 'reminders';

  const head = el('div', 'card__head');
  head.append(makeGrip(card));
  head.append(el('h2', 'card__title', 'Reminders'));
  reminderCountEl = el('span', 'card__count');
  head.append(reminderCountEl);
  card.append(head);
  attachCardDrag(card);
  attachCollapse(card, head, 'reminders');

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

function ensureRemindersCard() {
  if (!remindersCard) remindersCard = buildRemindersCard();
  return remindersCard;
}

/** Used only on the error path, where the brief failed but reminders should still work. */
function mountRemindersFallback() {
  const colEl = el('div', 'column');
  colEl.append(ensureRemindersCard());
  attachColumnDrop(colEl);
  board.append(colEl);
  markEmptyColumns();
  renderReminderList();
}

function renderReminderList() {
  if (!reminderListEl) return; // card not built yet; render() will call again
  const active = reminders.filter((r) => !r.done);
  const done = reminders.filter((r) => r.done);
  reminderCountEl.textContent = active.length ? String(active.length) : '';
  reminderCountEl.hidden = active.length === 0;

  reminderListEl.replaceChildren();
  if (reminders.length === 0) {
    delete reminderListEl.dataset.maxVisible;
    reminderListEl.append(el('p', 'card__empty', 'Nothing yet — jot something above.'));
    return;
  }
  // Active first (oldest at top so it nags), completed dimmed at the bottom.
  for (const reminder of [...active, ...done]) {
    reminderListEl.append(renderReminder(reminder));
  }
  // Apply the per-source row cap (same scroll mechanism as the sections).
  const cap = rowCaps.reminders || 0;
  if (cap && reminders.length > cap) reminderListEl.dataset.maxVisible = String(cap);
  else delete reminderListEl.dataset.maxVisible;
  capScrollSections();
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
    mountRemindersFallback();
  } finally {
    refreshButton.disabled = false;
  }
}

// ---- Settings screen --------------------------------------------------------

async function openSettings() {
  let fields;
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error(`server responded ${response.status}`);
    fields = (await response.json()).fields;
  } catch (error) {
    alert(`Couldn't load settings: ${error.message}`);
    return;
  }
  renderSettingsModal(fields);
}

/** Build a settings patch from a set of controls: only changed fields, null clears. */
function collectPatch(controls) {
  const patch = {};
  for (const { field, input, clear } of controls) {
    if (field.secret) {
      if (clear && clear.checked) patch[field.key] = null;
      else if (input.value.trim()) patch[field.key] = input.value.trim();
      // untouched secret → leave as is
    } else {
      const value = input.value.trim();
      if (value !== (field.value || '')) patch[field.key] = value === '' ? null : value;
    }
  }
  return patch;
}

/** Group fields by integration, preserving first-seen order. */
function groupByIntegration(fields) {
  const groups = new Map();
  for (const field of fields) {
    if (!groups.has(field.integration)) groups.set(field.integration, []);
    groups.get(field.integration).push(field);
  }
  return groups;
}

function renderSettingsModal(fields) {
  const overlay = el('div', 'modal-overlay');
  const panel = el('div', 'modal');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Integration settings');

  const head = el('div', 'modal__head');
  head.append(el('h2', 'modal__title', 'Settings'));
  const closeBtn = el('button', 'modal__close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  head.append(closeBtn);
  panel.append(head);

  const body = el('div', 'modal__body');
  const controls = []; // { field, input, clear }

  let dirty = false; // whether anything was saved, so we refresh the board on close
  const testable = new Set(['linear', 'gitlab', 'slack', 'calendar']);

  for (const [integration, groupFields] of groupByIntegration(fields)) {
    const source = integration.toLowerCase();
    const group = el('section', 'settings-group');
    group.dataset.source = source;

    const heading = el('div', 'settings-group__head');
    heading.append(el('span', 'settings-group__dot'));
    heading.append(el('h3', 'settings-group__title', integration));
    // The Connected/Not set pill only makes sense where there's a credential.
    let pill = null;
    if (groupFields.some((f) => f.secret)) {
      const on = groupFields.some((f) => f.secret && f.configured);
      pill = el('span', `settings-group__state${on ? ' is-on' : ''}`, on ? 'Connected' : 'Not set');
      heading.append(pill);
    }
    group.append(heading);

    const groupControls = [];
    for (const field of groupFields) {
      const row = el('label', 'settings-field');
      row.append(el('span', 'settings-field__label', field.label));

      const input = el('input');
      input.type = field.secret ? 'password' : field.number ? 'number' : 'text';
      if (field.number) input.min = '0';
      input.autocomplete = 'off';
      input.spellcheck = false;
      if (field.secret) {
        input.placeholder =
          field.source === 'settings'
            ? `${field.preview || 'saved'} — leave blank to keep`
            : field.source === 'env'
              ? 'set in .env — type to override'
              : 'not set';
      } else {
        input.value = field.value || '';
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      row.append(input);

      let clear = null;
      // Only settings-stored secrets can be cleared from here (.env is on disk).
      if (field.secret && field.source === 'settings') {
        const clearLabel = el('label', 'settings-field__clear');
        clear = el('input');
        clear.type = 'checkbox';
        clearLabel.append(clear, document.createTextNode(' remove'));
        row.append(clearLabel);
      }

      if (field.help) row.append(el('span', 'settings-field__help', field.help));
      group.append(row);
      const control = { field, input, clear };
      groupControls.push(control);
      controls.push(control);
    }

    // Per-integration actions: a status line and a Save button that also tests.
    const actions = el('div', 'settings-actions');
    const status = el('span', 'settings-status');

    if (integration === 'Slack') {
      const hasApp = groupFields.some((f) => f.key === 'SLACK_CLIENT_ID' && f.configured)
        && groupFields.some((f) => f.key === 'SLACK_CLIENT_SECRET' && f.configured);
      const oauth = el('button', 'button settings-connect', 'Connect with Slack');
      oauth.type = 'button';
      if (!hasApp) {
        oauth.disabled = true;
        oauth.title = 'Add the Client ID and secret, save, then connect.';
      }
      oauth.addEventListener('click', () => {
        window.location.href = '/slack/install';
      });
      actions.append(oauth);
    }

    const saveBtn = el('button', 'button button--primary', testable.has(source) ? 'Save & test' : 'Save');
    saveBtn.type = 'button';
    actions.append(saveBtn, status);
    group.append(actions);

    saveBtn.addEventListener('click', async () => {
      const patch = collectPatch(groupControls);
      saveBtn.disabled = true;
      status.className = 'settings-status';
      status.textContent = 'Saving…';
      try {
        if (Object.keys(patch).length) {
          const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (!response.ok) throw new Error(`save failed (${response.status})`);
        }
        dirty = true;
        if (testable.has(source)) {
          status.textContent = 'Testing…';
          const result = await fetch(`/api/test/${source}`).then((r) => r.json());
          if (result.ok) {
            status.textContent = `✓ Connected${result.detail ? ` · ${result.detail}` : ''}`;
            status.classList.add('is-ok');
            if (pill) {
              pill.textContent = 'Connected';
              pill.classList.add('is-on');
            }
          } else {
            status.textContent = `✗ ${result.error || 'not connected'}`;
            status.classList.add('is-err');
            if (pill) {
              pill.textContent = 'Not set';
              pill.classList.remove('is-on');
            }
          }
        } else {
          status.textContent = 'Saved';
        }
      } catch (error) {
        status.textContent = `✗ ${error.message}`;
        status.classList.add('is-err');
      } finally {
        saveBtn.disabled = false;
      }
    });

    body.append(group);
  }
  panel.append(body);

  const foot = el('div', 'modal__foot');
  foot.append(el('span', 'modal__note', 'Each integration saves & tests on its own.'));
  const done = el('button', 'button button--primary', 'Done');
  done.type = 'button';
  foot.append(done);
  panel.append(foot);

  overlay.append(panel);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (dirty) load({ force: true });
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);

  // Done saves any edits not yet saved via a group button, then closes.
  done.addEventListener('click', async () => {
    const patch = collectPatch(controls);
    if (Object.keys(patch).length) {
      done.disabled = true;
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        dirty = true;
      } catch {
        // If it fails, the per-group buttons still report their own errors.
      }
    }
    close();
  });

  const firstInput = panel.querySelector('input');
  if (firstInput) firstInput.focus();
}

greetingEl.textContent = greeting();
dateEl.textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

settingsButton.addEventListener('click', openSettings);
refreshButton.addEventListener('click', () => load({ force: true }));

// Returning from the Slack OAuth flow: confirm and drop the query param.
if (new URLSearchParams(location.search).get('slack') === 'connected') {
  setStatus('Slack connected');
  history.replaceState(null, '', location.pathname);
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // Don't hijack keystrokes while typing in a field or with a dialog open.
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.querySelector('.modal-overlay')) return;
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
