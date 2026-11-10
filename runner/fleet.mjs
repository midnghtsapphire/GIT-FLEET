#!/usr/bin/env node
// GIT-FLEET runner. Loads a member, applies Audrey's switches from Airtable,
// calls OpenRouter (or any OpenAI-compatible endpoint), saves a run report,
// writes the member's <file> blocks into its own workspace, posts its
// <post>/<reply> blocks to the whiteboard, and files <request-member> blocks
// as new-bot requests. Per Audrey's owner rule nothing is deleted, and an
// existing file is only replaced when it is listed in the member's living_files.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, cpSync } from 'node:fs';
import { join, resolve, dirname, sep, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as board from './board.mjs';
import { loadSettings, airtableOn, createRows, updateRow, toColumns, initSchema, DEFAULT_FLEET, FLEET_COLUMNS } from './settings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEMBERS = join(ROOT, 'members');
const RUNS = join(ROOT, 'runs');
const THINK = /<think>[\s\S]*?<\/think>\s*/g;
const FILE_BLOCK = /<file\s+path="([^"]+)">\r?\n?([\s\S]*?)<\/file>/g;
const POST_BLOCK = /<post\s+category="([^"]+)"\s+title="([^"]+)">\r?\n?([\s\S]*?)<\/post>/g;
const REPLY_BLOCK = /<reply\s+(discussion|issue)="(\d+)">\r?\n?([\s\S]*?)<\/reply>/g;
const REQUEST_BLOCK = /<request-member\s+name="([a-z0-9][a-z0-9-]*)">\r?\n?([\s\S]*?)<\/request-member>/g;
const FLEET_MARKER = '<!-- fleet:';
const FLEET_BRANCH = 'fleet/work';

let SETTINGS = { fleet: DEFAULT_FLEET, members: {}, source: 'defaults' };

// ---------- small helpers ----------

function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { pos, flags };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const stamp = (d = new Date()) => d.toISOString().replace(/:/g, '').replace(/\.\d+Z$/, 'Z'); // 2026-11-03T174501Z
const isoSeconds = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const today = () => new Date().toISOString().slice(0, 10);
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function listMembers() {
  return readdirSync(MEMBERS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(MEMBERS, d.name, 'member.json')))
    .map((d) => d.name)
    .sort();
}

// Airtable's Members row (when there is one) wins over member.json.
function applySettings(name, cfg) {
  const s = SETTINGS.members[name] ?? {};
  const out = { ...cfg, board: { ...(cfg.board ?? {}) } };
  if ('enabled' in s) out.enabled = s.enabled && s.status !== 'retired';
  if (s.model) out.model = s.model;
  if (s.fallback_model) out.fallback = { provider: cfg.fallback?.provider ?? 'openrouter', ...cfg.fallback, model: s.fallback_model };
  if (s.cadence) out.cadence = s.cadence;
  if ('post' in s) out.board.post = s.post;
  if ('respond' in s) out.board.respond = s.respond;
  if (s.max_runs_per_day) out.max_runs_per_day = s.max_runs_per_day;
  if (!SETTINGS.fleet.bots_can_post) out.board.post = false;
  out.settings_row = s.record_id ?? null;
  return out;
}

function loadMember(name) {
  const dir = join(MEMBERS, name);
  if (!existsSync(join(dir, 'member.json'))) throw new Error(`No member "${name}" (expected members/${name}/member.json)`);
  // Every member gets the shared fleet contract (output formats, whiteboard etiquette, owner rules).
  const contractPath = join(ROOT, 'templates', 'fleet-contract.md');
  const contract = existsSync(contractPath) ? readFileSync(contractPath, 'utf8').replaceAll('{{MEMBER}}', name) : '';
  const prompt = `${readFileSync(join(dir, 'prompt.md'), 'utf8').trim()}\n\n${contract.trim()}`.trim();
  return { name, dir, cfg: applySettings(name, readJson(join(dir, 'member.json'))), prompt };
}

const isActive = (name) => {
  const { cfg, dir } = loadMember(name);
  return cfg.enabled !== false && !existsSync(join(dir, 'KILL'));
};

// Never reuse a path: two runs in the same second get name.md, name-2.md, ...
function uniquePath(p) {
  if (!existsSync(p)) return p;
  const dot = p.lastIndexOf('.');
  const [base, ext] = dot > p.lastIndexOf(sep) ? [p.slice(0, dot), p.slice(dot)] : [p, ''];
  for (let i = 2; ; i++) if (!existsSync(`${base}-${i}${ext}`)) return `${base}-${i}${ext}`;
}

function memberRuns(name) {
  const dir = join(RUNS, name);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
}

// ---------- switches: fleet on/off, member on/off, optional caps, cadence ----------

function blockedReason(member, flags) {
  const { name, cfg, dir } = member;
  if (!SETTINGS.fleet.fleet_on) return 'the whole fleet is switched off (Fleet On)';
  if (cfg.enabled === false) return 'switched off (Enabled)';
  if (existsSync(join(dir, 'KILL'))) return 'KILL file present';
  const runs = memberRuns(name).filter((f) => !f.includes('-import'));
  const used = runs.filter((f) => f.startsWith(today())).length;
  if (cfg.max_runs_per_day && used >= cfg.max_runs_per_day) return `daily cap reached (${used}/${cfg.max_runs_per_day})`;
  const streak = cfg.max_consecutive_failures;
  if (streak && !flags.retry && runs.length >= streak && runs.slice(-streak).every((f) => f.includes('-failed'))) {
    return `${streak} failed runs in a row (fix the cause, then run manually with --retry)`;
  }
  return null;
}

function isDue(name, cadence) {
  const last = memberRuns(name).filter((f) => !f.includes('-import')).at(-1);
  if (!last) return cadence !== 'manual';
  if (cadence === 'daily') return last.slice(0, 10) < today();
  if (cadence === 'weekly') return Date.now() - Date.parse(last.slice(0, 10)) >= 7 * 864e5;
  return false;
}

// ---------- model call ----------

async function buildMessages(member, task) {
  const { cfg, dir, prompt } = member;
  const max = cfg.context_max_chars ?? 12000;
  const parts = [];
  const missing = [];
  const add = (tag, base, rel) => {
    const p = join(base, rel);
    if (!existsSync(p)) { missing.push(`${tag}:${rel}`); return; }
    parts.push(`<${tag} file="${rel}">\n${readFileSync(p, 'utf8').slice(0, max)}\n</${tag}>`);
  };
  for (const rel of cfg.context_files ?? []) add('standards', ROOT, rel);
  for (const rel of cfg.workspace_context ?? []) add('workspace', join(dir, 'workspace'), rel);
  let boardError = null;
  if (cfg.board?.read) {
    try { parts.push(`<whiteboard repo="${board.boardSlug()}">\n${await board.recent(cfg.board)}\n</whiteboard>`); }
    catch (e) { boardError = e.message; }
  }
  const system = parts.length ? `${prompt}\n\n<context>\n${parts.join('\n\n')}\n</context>` : prompt;
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: task }], missing, boardError };
}

function attemptsFor(cfg, flags) {
  if (flags.provider) return [{ provider: flags.provider, model: flags.model ?? cfg.model }];
  const list = [{ provider: cfg.provider, model: flags.model ?? cfg.model, extra_body: cfg.extra_body }];
  if (cfg.fallback) list.push(cfg.fallback);
  return list;
}

async function callModel(attempt, cfg, messages) {
  const providers = readJson(join(ROOT, 'config', 'providers.json'));
  const p = providers[attempt.provider];
  if (!p) throw new Error(`unknown provider "${attempt.provider}" (see config/providers.json)`);
  if (p.local_only && process.env.CI) throw new Error('skipped: local-only provider while running in CI');
  const baseUrl = (p.base_url_env && process.env[p.base_url_env]) || p.base_url;
  const headers = { 'Content-Type': 'application/json', ...(p.headers ?? {}) };
  if (p.api_key_env) {
    const key = process.env[p.api_key_env];
    if (!key) throw new Error(`${p.api_key_env} is not set`);
    headers.Authorization = `Bearer ${key}`;
  }
  const body = {
    model: attempt.model,
    messages,
    temperature: cfg.temperature ?? 0,
    max_tokens: cfg.max_tokens ?? 4000,
    ...(cfg.seed !== undefined && { seed: cfg.seed }),
    ...(attempt.extra_body ?? {}),
  };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(p.timeout_ms ?? 600000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`no content in response: ${text.slice(0, 400)}`);
  return { content: content.replace(THINK, ''), usage: data.usage ?? null, model: data.model ?? attempt.model };
}

// ---------- applying a reply: files, whiteboard posts, new-bot requests ----------

function safeTarget(root, rel) {
  const raw = rel.trim();
  const clean = normalize(raw).replace(/^[\\/]+/, '');
  if (!clean || isAbsolute(raw) || /^[a-zA-Z]:/.test(clean) || clean.split(/[\\/]/).includes('..')) return null;
  const target = resolve(root, clean);
  return target.startsWith(root + sep) ? target : null;
}

function writeFiles(content, workspace, runStamp, living = []) {
  const written = [];
  const rejected = [];
  for (const [, rel, body] of content.matchAll(FILE_BLOCK)) {
    const target = safeTarget(workspace, rel);
    if (!target) { rejected.push(rel); continue; }
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) { writeFileSync(target, body); written.push(rel); continue; }
    if (readFileSync(target, 'utf8') === body) { written.push(`${rel} (unchanged)`); continue; }
    if (living.includes(rel.trim().replace(/\\/g, '/'))) { writeFileSync(target, body); written.push(`${rel} (updated)`); continue; }
    // Never overwrite: park the new version next to the original for review.
    const parked = uniquePath(`${target}.incoming-${runStamp}`);
    writeFileSync(parked, body);
    written.push(`${rel}${parked.slice(target.length)}`);
  }
  return { written, rejected };
}

async function postToBoard(content, member, runStamp, origin, replyTo) {
  const out = { posted: [], errors: [] };
  const { name, cfg } = member;
  if (!cfg.board?.post) return out;
  const sign = (body) =>
    `**[${name}]** | run ${runStamp} | ${origin}\n\n${body.trim()}\n\n${FLEET_MARKER}member=${name};run=${runStamp} -->`;
  const jobs = [];
  for (const [, category, title, body] of content.matchAll(POST_BLOCK)) {
    jobs.push(() => board.createDiscussion(category, `[${name}] ${title}`, sign(body)));
  }
  const replyJob = (kind, num, body) => () => (kind === 'issue' ? board.issueReply(num, body) : board.reply(num, body));
  for (const [, kind, num, body] of content.matchAll(REPLY_BLOCK)) jobs.push(replyJob(kind, Number(num), sign(body)));
  if (!jobs.length && replyTo) {
    const plain = content.replace(FILE_BLOCK, '').replace(REQUEST_BLOCK, '').trim().slice(0, 6000);
    jobs.push(replyJob(replyTo.kind, replyTo.number, sign(plain)));
  }
  const max = cfg.board.max_posts_per_run ?? Infinity;
  for (const job of jobs.slice(0, max)) {
    try { out.posted.push(await job()); } catch (e) { out.errors.push(e.message); }
  }
  if (jobs.length > max) out.errors.push(`${jobs.length - max} post(s) over max_posts_per_run were not sent`);
  return out;
}

// Copies a member folder into members/<name> (never over an existing one).
function placeMember(name, fromDir, enabled) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('member names use lowercase letters, digits and dashes');
  const target = join(MEMBERS, name);
  if (existsSync(target)) throw new Error(`members/${name} already exists`);
  cpSync(fromDir, target, { recursive: true });
  for (const f of ['member.json', 'prompt.md']) {
    const p = join(target, f);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('{{MEMBER}}', name));
  }
  const cfgPath = join(target, 'member.json');
  writeFileSync(cfgPath, `${JSON.stringify({ ...readJson(cfgPath), name, enabled }, null, 2)}\n`);
  if (!existsSync(join(target, 'learnings.md'))) writeFileSync(join(target, 'learnings.md'), `# ${name} learnings\n`);
  return readJson(cfgPath);
}

async function addMemberRow(name, cfg, extra = {}) {
  if (!airtableOn()) return null;
  const [row] = await createRows('Members', [{
    Name: name, Enabled: cfg.enabled !== false, Role: cfg.role ?? '', Model: cfg.model ?? '',
    'Fallback Model': cfg.fallback?.model ?? '', Schedule: cfg.cadence ?? 'manual',
    'Can Post': cfg.board?.post !== false, 'Answers Mentions': cfg.board?.respond !== false,
    Status: cfg.enabled === false ? 'requested' : 'active', ...extra,
  }]);
  return row.id;
}

// A member asks for a new bot: its draft (workspace/agents/<name>/) becomes
// members/<name>. With "New Bots Need Approval" on, or at the "Max Active Bots"
// cap, it arrives switched off with a WR issue for Audrey to review.
async function requestMember(name, why, requester) {
  const draft = join(requester.dir, 'workspace', 'agents', name);
  if (!existsSync(join(draft, 'member.json')) || !existsSync(join(draft, 'prompt.md'))) {
    throw new Error(`write agents/${name}/member.json and agents/${name}/prompt.md in your workspace first`);
  }
  const active = listMembers().filter(isActive).length;
  const cap = Number(SETTINGS.fleet.max_active_bots) || Infinity;
  const atCap = active >= cap;
  const needsOk = SETTINGS.fleet.new_bots_need_approval || atCap;
  const cfg = placeMember(name, draft, !needsOk);
  let link = null;
  if (needsOk) {
    const reason = atCap ? `The fleet is at its cap (${active}/${cap} active bots).` : '"New Bots Need Approval" is on.';
    const body = [
      `**Requested by:** ${requester.name}`, `**Role:** ${cfg.role ?? ''}`, `**Model:** ${cfg.model ?? ''}`,
      `**Why:** ${why || '(no reason given)'}`, '',
      `Files: \`members/${name}/\`, in the fleet's draft PR (branch \`${FLEET_BRANCH}\`). ${reason}`, '',
      `To approve: merge the draft PR, then tick **Enabled** for \`${name}\` in Airtable (Members table).`,
      'To decline: leave Enabled unticked, or set Status to retired.',
    ].join('\n');
    try { link = await board.createIssue(board.repoSlug(), `[WR] New fleet member: ${name}`, body); }
    catch (e) { link = `WR not filed: ${e.message}`; }
  }
  try {
    await addMemberRow(name, cfg, { 'Requested By': requester.name, Notes: why, ...(link?.startsWith('http') && { 'Request Link': link }) });
  } catch (e) { link = `${link ?? ''} (Airtable row not added: ${e.message})`; }
  return needsOk ? `${name}: requested, starts switched off${link ? ` (${link})` : ''}` : `${name}: created and switched on`;
}

async function handleRequests(content, member) {
  const results = [];
  for (const [, name, why] of content.matchAll(REQUEST_BLOCK)) {
    try { results.push(await requestMember(name, why.trim(), member)); }
    catch (e) { results.push(`${name}: not created (${e.message})`); }
  }
  return results;
}

function saveRun(name, file, meta, content) {
  const dir = join(RUNS, name);
  mkdirSync(dir, { recursive: true });
  const header = Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const path = uniquePath(join(dir, file));
  writeFileSync(path, `---\n${header}\n---\n\n${content}\n`);
  return path.slice(ROOT.length + 1);
}

// Shows the latest run on the member's Airtable row.
async function noteRun(member, result) {
  if (!airtableOn() || !member.cfg.settings_row) return;
  try { await updateRow('Members', member.cfg.settings_row, { 'Last Run': new Date().toISOString(), 'Last Result': result.slice(0, 1000) }); }
  catch {}
}

// ---------- commands ----------

async function runMember(name, flags = {}, { task, replyTo, origin = 'manual' } = {}) {
  const member = loadMember(name);
  const why = blockedReason(member, flags);
  if (why) { console.log(`skip ${name}: ${why}`); return true; }
  const { messages, missing, boardError } = await buildMessages(member, task ?? (typeof flags.task === 'string' ? flags.task : member.cfg.task));
  const attempts = attemptsFor(member.cfg, flags);
  if (flags['dry-run']) {
    console.log(JSON.stringify({ member: name, settings: SETTINGS.source, attempts, missing_context: missing, board_error: boardError,
      system_chars: messages[0].content.length, task: messages[1].content }, null, 2));
    return true;
  }
  const started = new Date();
  const runStamp = stamp(started);
  const errors = [];
  for (const attempt of attempts) {
    try {
      console.log(`${name}: calling ${attempt.provider}/${attempt.model} ...`);
      const out = await callModel(attempt, member.cfg, messages);
      const files = writeFiles(out.content, join(member.dir, 'workspace'), runStamp, member.cfg.living_files);
      const posts = flags['no-post'] ? { posted: [], errors: ['--no-post'] } : await postToBoard(out.content, member, runStamp, `${attempt.provider}/${out.model}`, replyTo);
      const requests = await handleRequests(out.content, member);
      const report = saveRun(name, `${runStamp}.md`, {
        member: name, origin, provider: attempt.provider, model: out.model, started: started.toISOString(),
        duration_s: Math.round((Date.now() - started) / 1000), usage: out.usage, earlier_attempt_errors: errors,
        missing_context: missing, whiteboard_read_error: boardError, files_written: files.written,
        files_rejected: files.rejected, posts: posts.posted, post_errors: posts.errors, member_requests: requests,
      }, out.content);
      const summary = `ok: ${files.written.length} file(s), ${posts.posted.length} post(s)${requests.length ? `, ${requests.join('; ')}` : ''}`;
      console.log(`${name}: done -> ${report} (${summary})`);
      await noteRun(member, summary);
      return true;
    } catch (e) {
      errors.push(`${attempt.provider}/${attempt.model}: ${e.message}`);
    }
  }
  saveRun(name, `${runStamp}-failed.md`, { member: name, origin, started: started.toISOString() }, errors.map((e) => `- ${e}`).join('\n'));
  appendFileSync(join(member.dir, 'learnings.md'), `\n- ${runStamp} run failed: ${errors.join(' | ')}\n`);
  console.error(`${name}: all attempts failed:\n  ${errors.join('\n  ')}`);
  await noteRun(member, `failed: ${errors.join(' | ')}`);
  return false;
}

async function importReply(name, file, flags) {
  const member = loadMember(name);
  const content = readFileSync(resolve(file), 'utf8').replace(THINK, '');
  const runStamp = stamp();
  const files = writeFiles(content, join(member.dir, 'workspace'), runStamp, member.cfg.living_files);
  const source = typeof flags.from === 'string' ? flags.from : 'grok-app';
  const posts = flags['no-post'] ? { posted: [], errors: ['--no-post'] } : await postToBoard(content, member, runStamp, `${source} (imported)`);
  const requests = await handleRequests(content, member);
  const report = saveRun(name, `${runStamp}-import.md`, {
    member: name, origin: `import from ${source}`, source_file: file, files_written: files.written,
    files_rejected: files.rejected, posts: posts.posted, post_errors: posts.errors, member_requests: requests,
  }, content);
  console.log(`${name}: imported -> ${report} (${files.written.length} file(s), ${posts.posted.length} post(s))`);
  for (const r of requests) console.log(`  new member: ${r}`);
  if (files.rejected.length) console.log(`  rejected paths outside the workspace: ${files.rejected.join(', ')}`);
}

// Answers one whiteboard message if its "to:" line names fleet members.
async function respondTo({ kind, number, body }, flags) {
  // Loop guard: fleet-signed messages never wake members; only people and outside agents do.
  if (!number || body.includes(FLEET_MARKER)) return true;
  const to = body.match(/^\s*to:\s*([a-z0-9_, -]+)\s*$/im);
  const names = to ? to[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  const targets = names.filter((n) => listMembers().includes(n) && loadMember(n).cfg.board?.respond !== false);
  if (!targets.length) return true;
  const thread = kind === 'issue' ? await board.issueThread(number) : await board.thread(number);
  let ok = true;
  for (const name of targets) {
    const task = `${loadMember(name).cfg.respond_task ?? 'Someone addressed you on GitHub. Read the thread and answer it.'}\n` +
      `Answer with one <reply ${kind}="${number}"> block, plus any <file> blocks the answer needs.\n\n<thread>\n${thread}\n</thread>`;
    ok = (await runMember(name, flags, { task, replyTo: { kind, number }, origin: `${kind} #${number}` })) && ok;
  }
  return ok;
}

// GitHub event file (Actions or the act dispatcher) -> respondTo.
async function respond(flags) {
  const event = readJson(typeof flags.event === 'string' ? flags.event : process.env.GITHUB_EVENT_PATH);
  board.setBoardRepo(event.repository?.full_name ?? SETTINGS.fleet.whiteboard_repo);
  return respondTo({
    kind: event.issue ? 'issue' : 'discussion',
    number: event.issue?.number ?? event.discussion?.number,
    body: event.comment?.body ?? event.issue?.body ?? event.discussion?.body ?? '',
  }, flags);
}

// Checks the whiteboard for messages since the last check and answers them.
async function pollBoard(flags) {
  const statePath = join(RUNS, 'whiteboard-state.json');
  const repo = SETTINGS.fleet.whiteboard_repo;
  const now = isoSeconds();
  const state = existsSync(statePath) ? readJson(statePath) : {};
  mkdirSync(RUNS, { recursive: true });
  if (!state.since || state.repo !== repo) {
    writeFileSync(statePath, `${JSON.stringify({ repo, since: now }, null, 2)}\n`);
    console.log(`whiteboard: now watching ${repo}; messages from here on get answered`);
    return true;
  }
  const messages = await board.newMessages(state.since);
  let ok = true;
  for (const m of messages) ok = (await respondTo(m, flags)) && ok;
  writeFileSync(statePath, `${JSON.stringify({ repo, since: now }, null, 2)}\n`);
  console.log(`whiteboard: ${messages.length} new message(s) since ${state.since}`);
  return ok;
}

async function runDue(flags, where) {
  let ok = true;
  for (const n of listMembers()) {
    const { cfg } = loadMember(n);
    if (where && (cfg.runs_on ?? 'manual') !== where) continue;
    if (!isDue(n, cfg.cadence ?? 'manual')) continue;
    ok = (await runMember(n, flags, { origin: `scheduled${where ? ` (${where})` : ''}` })) && ok;
  }
  return ok;
}

// Commits whatever the fleet changed onto one rolling branch with one draft PR.
function openDraftPr() {
  try { sh('git', ['rev-parse', '--is-inside-work-tree']); } catch { return 'skipped (not a git repo yet)'; }
  if (!sh('git', ['status', '--porcelain'])) return 'no changes';
  if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== FLEET_BRANCH) {
    let exists = true;
    try { sh('git', ['rev-parse', '--verify', FLEET_BRANCH]); } catch { exists = false; }
    sh('git', exists ? ['switch', FLEET_BRANCH] : ['switch', '-c', FLEET_BRANCH]);
  }
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-m', `fleet: tick ${stamp()}`]);
  sh('git', ['push', '-u', 'origin', FLEET_BRANCH]);
  const open = sh('gh', ['pr', 'list', '--head', FLEET_BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url']);
  if (open) return `updated ${open}`;
  return `opened ${sh('gh', ['pr', 'create', '--draft', '--head', FLEET_BRANCH, '--title', 'fleet: work in progress', '--body',
    'Rolling draft PR from GIT-FLEET: findings, run reports and new-bot requests. Read runs/ and any .incoming-* files. ' +
    'Merge with "Create a merge commit" (not squash) so the fleet branch stays in step.'])}`;
}

async function tick(flags) {
  if (!SETTINGS.fleet.fleet_on) { console.log('Fleet is switched off (Fleet On).'); return true; }
  let ok = true;
  board.setBoardRepo(SETTINGS.fleet.whiteboard_repo);
  try { ok = (await pollBoard(flags)) && ok; } catch (e) { console.error(`whiteboard: ${e.message}`); ok = false; }
  ok = (await runDue(flags)) && ok;
  let pr = flags['no-pr'] ? 'skipped (--no-pr)' : 'off (Auto Draft PR)';
  if (SETTINGS.fleet.auto_draft_pr && !flags['no-pr']) {
    try { pr = openDraftPr(); } catch (e) { pr = `failed: ${e.message.split('\n')[0]}`; ok = false; }
  }
  console.log(`draft PR: ${pr}`);
  mkdirSync(RUNS, { recursive: true });
  appendFileSync(join(RUNS, 'tick.log'), `${isoSeconds()} ${ok ? 'ok' : 'had errors'} | settings: ${SETTINGS.source} | draft PR: ${pr}\n`);
  return ok;
}

async function settingsCommand(sub) {
  if (sub === 'init' || sub === 'sync') {
    if (!airtableOn()) throw new Error('Set AIRTABLE_TOKEN and AIRTABLE_BASE_ID in .env first');
  }
  if (sub === 'init') {
    for (const line of await initSchema()) console.log(line);
    SETTINGS = await loadSettings();
    sub = 'sync';
  }
  if (sub === 'sync') {
    if (!SETTINGS.fleet_record_id) {
      await createRows('Fleet', [{ Name: 'settings', ...toColumns(DEFAULT_FLEET, FLEET_COLUMNS) }]);
      console.log('Added the Fleet settings row with defaults.');
    }
    for (const n of listMembers()) {
      if (SETTINGS.members[n]) continue;
      await addMemberRow(n, readJson(join(MEMBERS, n, 'member.json')));
      console.log(`Added ${n} to Members.`);
    }
    SETTINGS = await loadSettings();
  }
  console.log(`Settings from: ${SETTINGS.source}\n`);
  for (const [k, v] of Object.entries(SETTINGS.fleet)) console.log(`  ${k}: ${v}`);
  console.log('');
  for (const n of listMembers()) {
    const { cfg } = loadMember(n);
    console.log(`  ${n}: ${cfg.enabled === false ? 'off' : 'on'} | ${cfg.model} | ${cfg.cadence ?? 'manual'} | posts ${cfg.board?.post ? 'on' : 'off'}`);
  }
}

function list(flags) {
  const rows = listMembers().map((n) => {
    const { cfg, dir } = loadMember(n);
    const state = cfg.enabled === false ? 'off' : existsSync(join(dir, 'KILL')) ? 'killed' : 'on';
    return `| ${n} | ${cfg.role ?? ''} | ${cfg.model} | ${cfg.cadence ?? 'manual'} | ${state} | ${memberRuns(n).length} |`;
  });
  const table = ['| Member | Role | Model | Schedule | State | Runs |', '|---|---|---|---|---|---|', ...rows].join('\n');
  console.log(table);
  if (flags.write) {
    writeFileSync(join(ROOT, 'ROSTER.md'), `# Fleet roster\n\nGenerated by \`node runner/fleet.mjs list --write\`. Do not edit by hand.\n\n${table}\n`);
    console.log('\nWrote ROSTER.md');
  }
}

function grokPrompt(name) {
  const { prompt } = loadMember(name);
  const adapter = readFileSync(join(ROOT, 'templates', 'grok-app-adapter.md'), 'utf8').replaceAll('{{MEMBER}}', name);
  process.stdout.write(`${prompt.trim()}\n\n${adapter.trim()}\n`);
}

const HELP = `GIT-FLEET runner

  tick                            check the whiteboard, run due members, update the draft PR
                                  (what the scheduled task runs every few minutes)
  settings [init|sync]            show the switches in use; init builds the Airtable tables
                                  (once, in an empty base), then fills rows; sync adds missing rows
  list [--write]                  show the roster (--write regenerates ROSTER.md)
  run <member> [options]          run one member now
      --provider <p> --model <m>  override the model (no fallback)
      --task "<text>"             override the task
      --dry-run                   show what would be sent, call nothing
      --no-post                   don't post to the whiteboard
      --retry                     run even after a failure streak
  due [--where <cloud|local>]     run every member whose schedule is due
  respond --event <file>          answer a GitHub event (GitHub Actions or the act dispatcher)
  import <member> <file> [--from <source>] [--no-post]
                                  apply a reply pasted from the Grok app (or any chat) to a member
  grok-prompt <member>            print the member's prompt with the Grok app adapter (pipe to clip)
  new <name>                      create a member from templates/member (starts switched off)
  board categories | board read [--limit n] | board thread <n>
`;

async function main() {
  // 2026-11-10 Codex, Audrey: owned prosecution uses the existing tick but must
  // return before .env/Airtable/whiteboard/model setup. Never fall through on error.
  const localArgs = parseArgs(process.argv.slice(2));
  if (localArgs.flags['local-only']) {
    if (localArgs.pos[0] !== 'tick' || typeof localArgs.flags.jobs !== 'string') {
      throw new Error('Use tick --local-only --jobs ABS_OPERATOR_CONFIG');
    }
    const { tickLocalJobs } = await import('./local-jobs.mjs');
    const result = tickLocalJobs(localArgs.flags.jobs, {
      retryFailed: localArgs.flags['retry-failed'] === true,
      retryUncertain: localArgs.flags['retry-uncertain'] === true,
    });
    console.log(JSON.stringify(result));
    return result.ok;
  }
  loadEnv();
  SETTINGS = await loadSettings();
  board.setBoardRepo(SETTINGS.fleet.whiteboard_repo);
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, a, b] = pos;
  switch (cmd) {
    case 'tick': return tick(flags);
    case 'settings': return settingsCommand(a);
    case 'list': return list(flags);
    case 'run': if (!a) break; return runMember(a, flags);
    case 'due': return runDue(flags, typeof flags.where === 'string' ? flags.where : null);
    case 'respond': return respond(flags);
    case 'import': if (!a || !b) break; return importReply(a, b, flags);
    case 'grok-prompt': if (!a) break; return grokPrompt(a);
    case 'new': {
      if (!a) break;
      const cfg = placeMember(a, join(ROOT, 'templates', 'member'), false);
      try { await addMemberRow(a, cfg); } catch (e) { console.log(`(Airtable row not added: ${e.message})`); }
      console.log(`Created members/${a}, switched off. Edit its prompt.md, then turn it on in Airtable or member.json.`);
      return true;
    }
    case 'board': {
      if (a === 'categories') return console.log((await board.categories()).join('\n'));
      if (a === 'read') return console.log(await board.recent({ read_limit: Number(flags.limit ?? 10) }));
      if (a === 'thread' && b) return console.log(await board.thread(Number(b)));
      break;
    }
  }
  console.log(HELP);
  return cmd === undefined || cmd === 'help';
}

main().then(
  (ok) => { if (ok === false) process.exitCode = 1; },
  (e) => { console.error(e.message); process.exitCode = 1; },
);
