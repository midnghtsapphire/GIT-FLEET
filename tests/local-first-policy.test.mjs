import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localFirstAttempts, shouldRetryAfterFailure } from '../runner/local-first-policy.mjs';

test('disabled mode preserves the original member routing', () => {
  assert.equal(localFirstAttempts({}), null);
  assert.equal(localFirstAttempts({ FLEET_LOCAL_FIRST: 'true' }), null);
});

test('local-first requires a named model', () => {
  assert.throws(() => localFirstAttempts({ FLEET_LOCAL_FIRST: '1' }), /LMSTUDIO_MODEL/);
  assert.throws(() => localFirstAttempts({ FLEET_LOCAL_FIRST: '1', LMSTUDIO_MODEL: '  ' }), /LMSTUDIO_MODEL/);
});

test('local-first has no cloud fallback by default', () => {
  assert.deepEqual(localFirstAttempts({ FLEET_LOCAL_FIRST: '1', LMSTUDIO_MODEL: 'local-chat' }),
    [{ provider: 'lmstudio', model: 'local-chat' }]);
});

test('explicit fallback uses the free OpenRouter router only', () => {
  assert.deepEqual(localFirstAttempts({ FLEET_LOCAL_FIRST: '1', LMSTUDIO_MODEL: 'local-chat', FLEET_FREE_FALLBACK: '1' }),
    [{ provider: 'lmstudio', model: 'local-chat' }, { provider: 'openrouter', model: 'openrouter/free' }]);
});

test('do not retry after applying a model response has started', () => {
  assert.equal(shouldRetryAfterFailure(false), true);
  assert.equal(shouldRetryAfterFailure(true), false);
});
