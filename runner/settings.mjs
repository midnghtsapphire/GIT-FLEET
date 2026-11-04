// Fleet settings: the on/off switches and limits Audrey flips in Airtable.
// Reads the "Fleet" and "Members" tables of the base in AIRTABLE_BASE_ID. When
// Airtable isn't configured or can't be reached, uses config/settings.json (the
// last good copy, also editable by hand) so runs never stall.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAVED = join(ROOT, 'config', 'settings.json');
const api = () => process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0';

export const DEFAULT_FLEET = {
  fleet_on: true,
  whiteboard_repo: 'midnghtsapphire/revvel-standards',
  max_active_bots: 10,
  new_bots_need_approval: true,
  bots_can_post: true,
  auto_draft_pr: true,
  default_model: 'qwen/qwen3.8-flash',
};

// Airtable column -> setting key. Airtable leaves unchecked checkboxes out of
// API responses, so a missing checkbox column means false.
export const FLEET_COLUMNS = {
  'Fleet On': 'fleet_on',
  'Whiteboard Repo': 'whiteboard_repo',
  'Max Active Bots': 'max_active_bots',
  'New Bots Need Approval': 'new_bots_need_approval',
  'Bots Can Post': 'bots_can_post',
  'Auto Draft PR': 'auto_draft_pr',
  'Default Model': 'default_model',
};
export const MEMBER_COLUMNS = {
  Enabled: 'enabled',
  Model: 'model',
  'Fallback Model': 'fallback_model',
  Schedule: 'cadence',
  'Can Post': 'post',
  'Answers Mentions': 'respond',
  'Max Runs Per Day': 'max_runs_per_day',
  Status: 'status',
};
const CHECKBOXES = new Set(['fleet_on', 'new_bots_need_approval', 'bots_can_post', 'auto_draft_pr', 'enabled', 'post', 'respond']);

export const airtableOn = () => Boolean(process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID);

async function call(method, path, body) {
  const res = await fetch(`${api()}/${process.env.AIRTABLE_BASE_ID}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Airtable ${method} ${path.split('?')[0]}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function rows(table) {
  const out = [];
  let offset;
  do {
    const data = await call('GET', `${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ''}`);
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

export async function createRows(table, records) {
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const data = await call('POST', encodeURIComponent(table), { records: records.slice(i, i + 10).map((fields) => ({ fields })), typecast: true });
    created.push(...data.records);
  }
  return created;
}

export async function updateRow(table, id, fields) {
  return call('PATCH', `${encodeURIComponent(table)}/${id}`, { fields, typecast: true });
}

function fromColumns(fields, columns) {
  const out = {};
  for (const [column, key] of Object.entries(columns)) {
    if (column in fields) out[key] = fields[column];
    else if (CHECKBOXES.has(key)) out[key] = false;
  }
  return out;
}

export function toColumns(values, columns) {
  const out = {};
  for (const [column, key] of Object.entries(columns)) if (values[key] !== undefined) out[column] = values[key];
  return out;
}

// ---------- one-time setup: build the Fleet and Members tables ----------

const check = (name, description) => ({ name, description, type: 'checkbox', options: { icon: 'check', color: 'greenBright' } });
const text = (name, description) => ({ name, description, type: 'singleLineText' });
const whole = (name, description) => ({ name, description, type: 'number', options: { precision: 0 } });
const pick = (name, description, choices) => ({ name, description, type: 'singleSelect', options: { choices: choices.map((c) => ({ name: c })) } });

export const SCHEMA = {
  Fleet: {
    description: 'One row of switches for the whole fleet. GIT-FLEET reads it at the start of every run.',
    fields: [
      text('Name', 'Just a label for the row.'),
      check('Fleet On', 'Master switch. Untick to stop every bot.'),
      text('Whiteboard Repo', 'owner/repo whose Discussions the bots post to and listen on.'),
      whole('Max Active Bots', 'Most bots allowed switched on at once. New bots past this wait for your OK.'),
      check('New Bots Need Approval', 'New bots arrive switched off with a WR issue for you to review.'),
      check('Bots Can Post', 'Untick to stop all posting to the whiteboard.'),
      check('Auto Draft PR', 'Each tick commits the fleet\'s changes to one rolling draft PR.'),
      text('Default Model', 'OpenRouter model ID for new bots.'),
    ],
  },
  Members: {
    description: 'One row per bot. A row here overrides the bot\'s member.json.',
    fields: [
      text('Name', 'Bot name; must match its folder under members/.'),
      check('Enabled', 'Turns this bot on or off.'),
      text('Role', 'What the bot is for.'),
      text('Model', 'OpenRouter model ID.'),
      text('Fallback Model', 'OpenRouter model ID to try if the main one fails.'),
      pick('Schedule', 'How often the bot runs on its own.', ['daily', 'weekly', 'manual']),
      check('Can Post', 'This bot may post to the whiteboard.'),
      check('Answers Mentions', 'This bot answers whiteboard messages that say "to: <its name>".'),
      whole('Max Runs Per Day', 'Optional cap. Blank means no cap.'),
      pick('Status', 'requested = waiting for your OK; retired = off for good.', ['active', 'requested', 'retired']),
      text('Requested By', 'Which bot asked for this one.'),
      { name: 'Request Link', description: 'The WR issue for this request.', type: 'url' },
      { name: 'Notes', description: 'Why it was requested, or your notes.', type: 'multilineText' },
      text('Last Run', 'Written by the runner: when the bot last ran (UTC).'),
      { name: 'Last Result', description: 'Written by the runner: what the last run did.', type: 'multilineText' },
    ],
  },
};

async function meta(method, path, body) {
  const res = await fetch(`${api()}/meta/bases/${process.env.AIRTABLE_BASE_ID}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Airtable schema ${method} ${path}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Creates missing tables and missing columns. Never removes or changes existing ones.
export async function initSchema() {
  const done = [];
  const { tables } = await meta('GET', 'tables');
  for (const [name, spec] of Object.entries(SCHEMA)) {
    const existing = tables.find((t) => t.name === name);
    if (!existing) {
      await meta('POST', 'tables', { name, description: spec.description, fields: spec.fields });
      done.push(`created table ${name} (${spec.fields.length} columns)`);
      continue;
    }
    const have = new Set(existing.fields.map((f) => f.name));
    for (const field of spec.fields.filter((f) => !have.has(f.name))) {
      await meta('POST', `tables/${existing.id}/fields`, field);
      done.push(`added column ${name}.${field.name}`);
    }
  }
  return done.length ? done : ['tables already set up'];
}

export async function loadSettings() {
  let saved = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : {};
  let source = 'config/settings.json';
  if (airtableOn()) {
    try {
      const [fleetRows, memberRows] = await Promise.all([rows('Fleet'), rows('Members')]);
      const members = {};
      for (const r of memberRows) {
        const name = String(r.fields.Name ?? '').trim().toLowerCase();
        if (name) members[name] = { ...fromColumns(r.fields, MEMBER_COLUMNS), record_id: r.id };
      }
      saved = {
        fleet: fleetRows[0] ? fromColumns(fleetRows[0].fields, FLEET_COLUMNS) : {},
        fleet_record_id: fleetRows[0]?.id ?? null,
        members,
        synced_from_airtable: new Date().toISOString(),
      };
      writeFileSync(SAVED, `${JSON.stringify(saved, null, 2)}\n`);
      source = 'airtable';
    } catch (e) {
      source = `config/settings.json (Airtable unreachable: ${e.message})`;
    }
  }
  return {
    fleet: { ...DEFAULT_FLEET, ...(saved.fleet ?? {}) },
    fleet_record_id: saved.fleet_record_id ?? null,
    members: saved.members ?? {},
    source,
  };
}
