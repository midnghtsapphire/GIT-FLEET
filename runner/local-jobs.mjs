// 2026-11-10 Codex, Audrey's daily/event prosecution request.
// This is scheduling, not another executor: only HULL receives fixed commands.
// Keep it independent of fleet settings/.env/board so local checks need no account.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const digest = value => createHash('sha256').update(value).digest('hex');
const absolute = (value, label) => {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
};
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));

function reviewPacket(review) {
  absolute(review.git, 'review.git');
  const workspace = realpathSync(absolute(review.workspace, 'review.workspace'));
  if (!/^[0-9a-f]{40}$/.test(review.base ?? '')) throw new Error('review.base must be an explicit commit SHA');
  const git = args => {
    const result = spawnSync(review.git, ['-c', 'core.fsmonitor=false', '-C', workspace, ...args], {
      shell: false, windowsHide: true, env: minimalEnvironment(), encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Local review metadata failed; no HULL invocation');
    return result.stdout;
  };
  const head = git(['rev-parse', 'HEAD']).trim();
  // Untracked files are not represented by git diff. Refuse a misleading clean
  // review until the operator stages them; never silently omit new source.
  if (git(['ls-files', '--others', '--exclude-standard']).trim()) throw new Error('Stage new local source before generating a review packet');
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', review.base, '--', '.']);
  if (!diff.trim()) throw new Error('Review baseline has no diff; choose an explicit delivery baseline');
  return JSON.stringify({ head: `${head};worktree-diff-sha256:${digest(diff)}`, base: review.base, diff, comments: [] });
}

export function loadLocalJobs(path) {
  const configText = read(absolute(path, 'jobs config'));
  const config = JSON.parse(configText);
  if (config.version !== 1 || !Array.isArray(config.jobs) || !config.jobs.length || config.jobs.length > 50) {
    throw new Error('Expected version 1 and 1..50 local jobs');
  }
  const timezone = config.timezone ?? 'America/Denver';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  absolute(config.state, 'state');
  const names = new Set();
  const jobs = config.jobs.map(job => {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(job.id ?? '') || names.has(job.id)) throw new Error('Job IDs must be unique lowercase names');
    names.add(job.id);
    const hull = job.hull;
    if (!hull || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(hull.skill ?? '')) throw new Error('Invalid HULL skill');
    for (const key of ['python', 'entry', 'skills', 'policy', 'receipts']) absolute(hull[key], `hull.${key}`);
    if (!hull.entry.replaceAll('\\', '/').endsWith('/scripts/local-hull.py')) throw new Error('Use the existing HULL scripts/local-hull.py entry point');
    for (const key of ['python', 'entry', 'skills', 'policy']) realpathSync(hull[key]);
    // An operator may supply a packet, or ask the existing tick to derive one
    // from a fixed local Git baseline. No remote GitHub API/event is required.
    let packet;
    if (job.review) packet = reviewPacket(job.review);
    else {
      absolute(job.packet, 'packet');
      if (statSync(job.packet).size > 4 * 1024 * 1024) throw new Error('Packet exceeds 4 MiB');
      packet = read(job.packet);
    }
    if (Buffer.byteLength(packet) > 4 * 1024 * 1024) throw new Error('Packet exceeds 4 MiB');
    const policyText = read(hull.policy);
    const policy = JSON.parse(policyText);
    const rule = policy.skills?.[hull.skill];
    // Review correction, 2026-11-10: HULL itself caps commands at 3600 seconds.
    // Earlier local validation allowed 7200, which HULL would refuse.
    if (policy.version !== 1 || !rule || !Number.isInteger(rule.timeout_seconds) || rule.timeout_seconds < 1 || rule.timeout_seconds > 3600) {
      throw new Error('HULL policy must define the skill with a 1..3600 second timeout');
    }
    // The first draft permitted a matching --packet override, but a later edit
    // could race the fingerprint. HULL stdin now uses an immutable run snapshot.
    if (rule.argv?.includes('--packet')) throw new Error('Use HULL stdin instead of a --packet override');
    const manifest = read(join(hull.skills, hull.skill, 'SKILL.md'));
    if (job.watch !== undefined && (!Array.isArray(job.watch) || job.watch.some(p => typeof p !== 'string'))) throw new Error('watch must be an array of absolute dependency paths');
    const dependencies = (job.watch ?? []).map(path => [absolute(path, 'watch path'), read(path)]);
    // Include policy/manifest/config changes so a prior pass cannot hide a new command.
    const fingerprint = digest(JSON.stringify([configText, packet, policyText, manifest, dependencies]));
    return { ...job, packetText: packet, fingerprint, timeoutMs: (rule.timeout_seconds + 30) * 1000 };
  });
  return { ...config, timezone, jobs };
}

function localDay(now, timezone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-');
}

function minimalEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.PYTHONUTF8 = '1';
  return env;
}

function invokeHull(job) {
  const h = job.hull;
  // Earlier draft omitted --input, leaving HULL with {} unless policy argv
  // separately supplied --packet. Bind the watched packet to actual execution.
  // const args = [h.entry, '--skills', h.skills, 'run', h.skill, '--policy', h.policy, '--receipts', h.receipts];
  const args = [h.entry, '--skills', h.skills, 'run', h.skill, '--policy', h.policy, '--receipts', h.receipts, '--input', job.inputPath];
  const result = spawnSync(h.python, args, { shell: false, windowsHide: true,
    cwd: dirname(h.entry), env: minimalEnvironment(), timeout: job.timeoutMs,
    encoding: 'utf8', maxBuffer: 1024 * 1024 });
  // HULL normally owns its timeout and tree cleanup. An outer watchdog/buffer
  // interruption may kill only Python, leaving descendants uncertain. Never
  // auto-replay that attempt as an ordinary failed check; require inspection.
  const uncertain = result.signal || (result.error && !['ENOENT', 'EACCES', 'ENOEXEC'].includes(result.error.code));
  return { status: uncertain ? 'uncertain' : !result.error && result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status, errorCode: result.error?.code ?? null,
    stdoutSha256: digest(result.stdout ?? ''), stderrSha256: digest(result.stderr ?? '') };
}

export function tickLocalJobs(configPath, { now = new Date(), retryFailed = false, retryUncertain = false, invoke = invokeHull } = {}) {
  const config = loadLocalJobs(configPath);
  mkdirSync(dirname(config.state), { recursive: true });
  const db = new DatabaseSync(config.state);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY, job TEXT NOT NULL, fingerprint TEXT NOT NULL, day TEXT NOT NULL,
    started INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL, result TEXT);
    CREATE INDEX IF NOT EXISTS job_attempts ON attempts(job, started);`);
  const reports = [];
  const day = localDay(now, config.timezone);
  const tickStarted = Date.now();
  try {
    for (const job of config.jobs) {
      const id = randomUUID();
      // Earlier jobs can consume minutes. Lease time starts when this job is
      // acquired, rather than expiring relative to the start of the entire tick.
      const acquiredAt = now.getTime() + Date.now() - tickStarted;
      const claimDay = localDay(new Date(acquiredAt), config.timezone);
      db.exec('BEGIN IMMEDIATE');
      try {
        const active = db.prepare("SELECT * FROM attempts WHERE job=? AND status='running' ORDER BY started DESC LIMIT 1").get(job.id);
        if (active && active.expires > acquiredAt) {
          db.exec('COMMIT'); reports.push({ job: job.id, status: 'overlap', attempt: active.id }); continue;
        }
        if (active) db.prepare("UPDATE attempts SET status='uncertain' WHERE id=?").run(active.id);
        const uncertain = db.prepare("SELECT id FROM attempts WHERE job=? AND status='uncertain' ORDER BY started DESC LIMIT 1").get(job.id);
        if (uncertain && !retryUncertain) {
          db.exec('COMMIT'); reports.push({ job: job.id, status: 'uncertain', attempt: uncertain.id }); continue;
        }
        // Acknowledge uncertainty explicitly without deleting the historical attempt.
        if (uncertain && retryUncertain) db.prepare("UPDATE attempts SET status='uncertain-reviewed' WHERE job=? AND status='uncertain'").run(job.id);
        // Journal insertion order survives clock corrections and deterministic
        // clock tests; wall-clock ordering could select an older fingerprint.
        // const last = db.prepare("SELECT * FROM attempts WHERE job=? AND status IN ('passed','failed') ORDER BY started DESC, rowid DESC LIMIT 1").get(job.id);
        const last = db.prepare("SELECT * FROM attempts WHERE job=? AND status IN ('passed','failed') ORDER BY rowid DESC LIMIT 1").get(job.id);
        if (last && last.fingerprint === job.fingerprint && last.day === claimDay && !(retryFailed && last.status === 'failed')) {
          db.exec('COMMIT'); reports.push({ job: job.id, status: last.status === 'passed' ? 'unchanged' : 'failed-held', attempt: last.id }); continue;
        }
        db.prepare('INSERT INTO attempts(id,job,fingerprint,day,started,expires,status) VALUES(?,?,?,?,?,?,?)')
          .run(id, job.id, job.fingerprint, claimDay, acquiredAt, acquiredAt + job.timeoutMs + 60000, 'running');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      let result;
      try {
        const inputs = join(dirname(config.state), 'inputs');
        mkdirSync(inputs, { recursive: true });
        const inputPath = join(inputs, `${id}.json`);
        writeFileSync(inputPath, job.packetText, { flag: 'wx' });
        result = invoke({ ...job, inputPath });
        // A concurrent edit must not inherit a receipt for a different source
        // tree. Preserve both attempted work and the uncertain result.
        if (job.review && reviewPacket(job.review) !== job.packetText) result = { ...result, status: 'uncertain', errorCode: 'WORKSPACE_CHANGED_DURING_CHECK' };
      } catch { result = { status: 'uncertain', errorCode: 'HULL_INVOCATION_INTERRUPTED' }; }
      if (!['passed', 'failed', 'uncertain'].includes(result?.status)) result = { status: 'uncertain', errorCode: 'INVALID_HULL_RESULT' };
      db.prepare('UPDATE attempts SET status=?, result=? WHERE id=? AND status=\'running\'').run(result.status, JSON.stringify(result), id);
      reports.push({ job: job.id, attempt: id, ...result });
    }
    return { version: 1, day, timezone: config.timezone, ok: reports.every(r => ['passed', 'unchanged'].includes(r.status)), reports };
  } finally { db.close(); }
}
