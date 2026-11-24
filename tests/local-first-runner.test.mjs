import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t, names = ['alpha']) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['runner', 'config']) {
    cpSync(new URL(`../${dir}/`, import.meta.url), join(root, dir), { recursive: true });
  }
  for (const name of names) {
    const dir = join(root, 'members', name);
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    writeFileSync(join(dir, 'prompt.md'), 'Write a report.');
    writeFileSync(join(dir, 'member.json'), JSON.stringify({
      cadence: 'daily', provider: 'openrouter', model: 'member-paid',
      fallback: { provider: 'openrouter', model: 'fallback-paid' }, task: 'Write a report.',
    }));
  }
  const preload = join(root, 'stub-fetch.mjs');
  writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, request) => {
  const { model } = JSON.parse(request.body);
  appendFileSync('calls.log', JSON.stringify({ url, model }) + '\\n');
  if (model === 'local-chat' && process.env.TEST_LOCAL_DOWN === '1') {
    return new Response('offline', { status: 503 });
  }
  return Response.json({ choices: [{ message: { content:
    '<file path="report.md">saved</file><file path="blocked/child.md">fails</file>'
  } }] });
};
`);
  return {
    root,
    run(args, env = {}) {
      const result = spawnSync(process.execPath, ['--import', './stub-fetch.mjs', 'runner/fleet.mjs', ...args], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: '', CI: '', AIRTABLE_TOKEN: '', AIRTABLE_BASE_ID: '',
          LMSTUDIO_BASE_URL: 'http://localhost:1234/v1', OPENROUTER_API_KEY: 'test-key',
          FLEET_LOCAL_FIRST: '1', FLEET_FREE_FALLBACK: '1', LMSTUDIO_MODEL: 'local-chat',
          TEST_LOCAL_DOWN: '', ...env },
      });
      if (result.error) throw result.error;
      return result;
    },
    calls() {
      return readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    },
    failure(name) {
      const dir = join(root, 'runs', name);
      const reports = readdirSync(dir);
      assert.equal(reports.length, 1);
      assert.match(reports[0], /-failed\.md$/);
      return readFileSync(join(dir, reports[0]), 'utf8');
    },
  };
}

const local = { url: 'http://localhost:1234/v1/chat/completions', model: 'local-chat' };
const free = { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free' };
const runWithOverride = ['run', 'alpha', '--provider', 'openrouter', '--model', 'cli-paid'];

test('local-first overrides CLI and member models and uses only the free fallback', (t) => {
  const fleet = fixture(t);
  const result = fleet.run(runWithOverride, { TEST_LOCAL_DOWN: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fleet.calls(), [local, free]);
});

test('output application failure records the run without calling a fallback', (t) => {
  const fleet = fixture(t);
  const workspace = join(fleet.root, 'members', 'alpha', 'workspace');
  writeFileSync(join(workspace, 'blocked'), 'A file blocks the second write.');
  const result = fleet.run(runWithOverride);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(fleet.calls(), [local]);
  assert.equal(readFileSync(join(workspace, 'report.md'), 'utf8'), 'saved');
  assert.match(fleet.failure('alpha'), /lmstudio\/local-chat: .*blocked/);
});

test('missing local model records each due member failure and makes no model calls', (t) => {
  const names = ['alpha', 'beta'];
  const fleet = fixture(t, names);
  const result = fleet.run(['due'], { LMSTUDIO_MODEL: '  ' });
  assert.equal(result.status, 1, result.stderr);
  assert.throws(() => fleet.calls(), { code: 'ENOENT' });
  for (const name of names) {
    assert.match(fleet.failure(name), /requires LMSTUDIO_MODEL/);
    assert.match(readFileSync(join(fleet.root, 'members', name, 'learnings.md'), 'utf8'), /requires LMSTUDIO_MODEL/);
  }
});

test('local-first records a refusal for members that need the web plugin', (t) => {
  const fleet = fixture(t, ['gamma']);
  writeFileSync(join(fleet.root, 'members', 'gamma', 'member.json'), JSON.stringify({
    cadence: 'manual', provider: 'openrouter', model: 'member-paid',
    task: 'Research with web search.',
    extra_body: { plugins: [{ id: 'web' }] },
  }));
  const result = fleet.run(['run', 'gamma']);
  assert.equal(result.status, 1, result.stderr);
  assert.throws(() => fleet.calls(), { code: 'ENOENT' });
  assert.match(fleet.failure('gamma'), /web search plugin/);
});

test('local-first ignores non-web plugins', (t) => {
  const fleet = fixture(t, ['gamma']);
  writeFileSync(join(fleet.root, 'members', 'gamma', 'member.json'), JSON.stringify({
    cadence: 'manual', provider: 'openrouter', model: 'member-paid',
    task: 'Write a report.',
    extra_body: { plugins: [{ id: 'code-interpreter' }] },
  }));
  const result = fleet.run(['run', 'gamma']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fleet.calls(), [local]);
});
