import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadLocalJobs, tickLocalJobs } from './local-jobs.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-owned-check-'));
  const entry = join(root, 'scripts/local-hull.py');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'skills/prosecute'), { recursive: true });
  writeFileSync(entry, '// Fixture only; the real HULL invocation is separately integrated.');
  writeFileSync(join(root, 'skills/prosecute/SKILL.md'), 'operator manifest');
  const policy = join(root, 'policy.json');
  const packet = join(root, 'packet.json');
  writeFileSync(packet, '{"head":"test-head","diff":"+real change"}');
  writeFileSync(policy, JSON.stringify({ version: 1, skills: { prosecute: { timeout_seconds: 1 } } }));
  const config = { version: 1, timezone: 'America/Denver', state: join(root, 'journal.sqlite'), jobs: [{
    id: 'prosecute', packet, hull: { python: process.execPath, entry, skills: join(root, 'skills'), policy, skill: 'prosecute', receipts: join(root, 'receipts') },
  }] };
  const path = join(root, 'jobs.json');
  const save = () => writeFileSync(path, JSON.stringify(config));
  save();
  return { root, config, path, save, packet, policy };
}
const date = value => new Date(value);

test('unchanged successful packet runs once per Denver calendar day, changed packet runs immediately', () => {
  const f = fixture(); let calls = 0;
  const invoke = () => { calls++; return { status: 'passed' }; };
  const options = { now: date('2026-11-10T23:00:00Z'), invoke };
  assert.equal(tickLocalJobs(f.path, options).reports[0].status, 'passed');
  assert.equal(tickLocalJobs(f.path, options).reports[0].status, 'unchanged');
  writeFileSync(f.packet, '{"head":"next","diff":"+changed"}');
  assert.equal(tickLocalJobs(f.path, options).reports[0].status, 'passed');
  assert.equal(tickLocalJobs(f.path, { ...options, now: date('2026-11-11T06:59:00Z') }).reports[0].status, 'unchanged');
  assert.equal(tickLocalJobs(f.path, { ...options, now: date('2026-11-11T07:01:00Z') }).reports[0].status, 'passed');
  assert.equal(calls, 3);
});

test('failed checks are held without a retry loop, retry is explicit and attempt history remains', () => {
  const f = fixture(); let calls = 0;
  const options = { now: date('2026-11-10T23:00:00Z'), invoke: () => { calls++; return { status: 'failed', exitCode: 7 }; } };
  assert.equal(tickLocalJobs(f.path, options).ok, false);
  assert.equal(tickLocalJobs(f.path, options).reports[0].status, 'failed-held');
  assert.equal(calls, 1);
  tickLocalJobs(f.path, { ...options, retryFailed: true });
  const db = new DatabaseSync(f.config.state);
  assert.equal(db.prepare('SELECT count(*) AS n FROM attempts').get().n, 2); db.close();
});

test('concurrent tick cannot acquire the live job lease', () => {
  const f = fixture(); const now = date('2026-11-10T23:00:00Z');
  let nested;
  tickLocalJobs(f.path, { now, invoke: () => {
    nested = tickLocalJobs(f.path, { now, invoke: () => assert.fail('overlap invoked HULL') });
    return { status: 'passed' };
  } });
  assert.equal(nested.reports[0].status, 'overlap'); assert.equal(nested.ok, false);
});

test('expired execution remains uncertain until explicitly reviewed, no automatic replay', () => {
  const f = fixture(); const now = date('2026-11-10T23:00:00Z');
  tickLocalJobs(f.path, { now, invoke: () => ({ status: 'passed' }) });
  const db = new DatabaseSync(f.config.state);
  db.prepare("UPDATE attempts SET status='running', expires=0").run(); db.close();
  assert.equal(tickLocalJobs(f.path, { now, invoke: () => assert.fail('uncertain run replayed') }).reports[0].status, 'uncertain');
  const reviewed = tickLocalJobs(f.path, { now, retryUncertain: true, invoke: () => ({ status: 'passed' }) });
  assert.equal(reviewed.ok, true);
});

test('manifest or HULL policy changes invalidate earlier success', () => {
  const f = fixture(); let calls = 0;
  const options = { invoke: () => { calls++; return { status: 'passed' }; } };
  tickLocalJobs(f.path, options);
  writeFileSync(join(f.root, 'skills/prosecute/SKILL.md'), 'new manifest');
  tickLocalJobs(f.path, options);
  writeFileSync(f.policy, JSON.stringify({ version: 1, skills: { prosecute: { timeout_seconds: 2 } } }));
  tickLocalJobs(f.path, options); assert.equal(calls, 3);
});

test('invalid and duplicate operator configuration fails closed', () => {
  const f = fixture(); f.config.jobs.push(f.config.jobs[0]); f.save();
  assert.throws(() => loadLocalJobs(f.path), /unique/);
  f.config.jobs.pop(); f.config.jobs[0].hull.entry = process.execPath; f.save();
  assert.throws(() => loadLocalJobs(f.path), /existing HULL/);
});

test('real subprocess invokes only the fixed HULL entry and filters provider credentials', () => {
  const f = fixture();
  // Node substitutes for Python solely in this fixture; the argv entry file is real.
  // HULL itself is integrated using the actual Python runtime in the release receipt.
  writeFileSync(f.config.jobs[0].hull.entry, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(f.root, 'observed.json'))},JSON.stringify({args:process.argv.slice(2),secret:process.env.OPENROUTER_API_KEY}));`);
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-sentinel-not-a-real-key';
  try {
    const report = tickLocalJobs(f.path);
    assert.equal(report.ok, true);
    const seen = JSON.parse(readFileSync(join(f.root, 'observed.json'), 'utf8'));
    assert.equal(seen.secret, undefined);
    assert.deepEqual(seen.args.slice(0, -1), ['--skills', f.config.jobs[0].hull.skills, 'run', 'prosecute', '--policy', f.policy, '--receipts', f.config.jobs[0].hull.receipts, '--input']);
    assert.match(seen.args.at(-1).replaceAll('\\', '/'), /\/inputs\/[a-f0-9-]+\.json$/);
    assert.equal(readFileSync(seen.args.at(-1), 'utf8'), readFileSync(f.packet, 'utf8'));
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('explicit downstream policy watch invalidates pass and execution uses a retained input snapshot', () => {
  const f = fixture(); const dependency = join(f.root, 'prosecution-policy.json');
  writeFileSync(dependency, '{"checks":["first"]}');
  f.config.jobs[0].watch = [dependency]; f.save();
  let calls = 0;
  const invoke = job => { calls++; assert.equal(readFileSync(job.inputPath, 'utf8'), job.packetText); return { status: 'passed' }; };
  tickLocalJobs(f.path, { invoke });
  writeFileSync(dependency, '{"checks":["second"]}');
  tickLocalJobs(f.path, { invoke }); assert.equal(calls, 2);
});

test('real outer output watchdog marks uncertain and blocks automatic changed-packet replay', () => {
  const f = fixture();
  writeFileSync(f.config.jobs[0].hull.entry, "process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);");
  assert.equal(tickLocalJobs(f.path).reports[0].status, 'uncertain');
  writeFileSync(f.packet, '{"head":"new","diff":"+new"}');
  assert.equal(tickLocalJobs(f.path, { invoke: () => assert.fail('uncertain work auto-replayed') }).reports[0].status, 'uncertain');
});

test('local-only CLI refuses missing configuration before touching legacy integrations', () => {
  const child = spawnSync(process.execPath, [resolve('runner/fleet.mjs'), 'tick', '--local-only'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, AIRTABLE_API_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(child.status, 1); assert.match(child.stderr, /ABS_OPERATOR_CONFIG/);
  assert.doesNotMatch(child.stderr, /fetch|Airtable|OpenRouter/i);
});

test('local Git baseline supplies the actual head/diff and rejects source edits during execution', () => {
  const f = fixture();
  const gitBinary = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git';
  const git = args => {
    const result = spawnSync(gitBinary, ['-C', f.root, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(['init']);
  writeFileSync(join(f.root, '.gitignore'), '*\n!source.js\n');
  writeFileSync(join(f.root, 'source.js'), 'const original = 1;\n');
  git(['add', '-f', '.gitignore', 'source.js']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const base = git(['rev-parse', 'HEAD']);
  writeFileSync(join(f.root, 'source.js'), 'const original = 2;\n');
  delete f.config.jobs[0].packet;
  f.config.jobs[0].review = { git: gitBinary, workspace: f.root, base }; f.save();
  const result = tickLocalJobs(f.path, { invoke: job => {
    const packet = JSON.parse(readFileSync(job.inputPath));
    assert.match(packet.head, new RegExp(`^${base};worktree-diff-sha256:`));
    assert.match(packet.diff, /\+const original = 2/);
    writeFileSync(join(f.root, 'source.js'), 'const original = 3;\n');
    return { status: 'passed' };
  } });
  assert.equal(result.reports[0].status, 'uncertain');
  assert.equal(result.reports[0].errorCode, 'WORKSPACE_CHANGED_DURING_CHECK');
});

test('a Git review refuses to omit new untracked source', () => {
  const f = fixture();
  const gitBinary = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : '/usr/bin/git';
  const result = spawnSync(gitBinary, ['-C', f.root, 'init'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const commit = spawnSync(gitBinary, ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const head = spawnSync(gitBinary, ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  // Existing fixture files are intentionally untracked. No command can be
  // invoked from them while the reviewer has an incomplete source inventory.
  delete f.config.jobs[0].packet;
  f.config.jobs[0].review = { git: gitBinary, workspace: f.root, base: head }; f.save();
  assert.throws(() => tickLocalJobs(f.path, { invoke: () => assert.fail('untracked source executed') }), /Stage new local source/);
});
