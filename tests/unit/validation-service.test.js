// When the LLM provider is configured but fails (network down, timeout, bad
// key), validation must fall back to the rules engine - never report success
// it did not verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VALIDATION_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'sk-ant-invalid-test-key';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'; // nothing listens here
process.env.VALIDATION_TIMEOUT_MS = '2000';
const { validate } = await import('../../server/validation/index.js');

test('provider failure falls back to rules and keeps vague feedback blocked', async () => {
  const r = await validate({ text: 'Move this.' });
  assert.equal(r.fallback, true);
  assert.equal(r.provider, 'rules');
  assert.equal(r.canSubmit, false);
  assert.match(r.questions[0], /Where should/);
});

test('provider failure still lets specific feedback through via rules', async () => {
  const r = await validate({ text: 'Move this button to the right of the image' });
  assert.equal(r.fallback, true);
  assert.equal(r.canSubmit, true);
});

test('empty text is rejected without calling the provider', async () => {
  const r = await validate({ text: '   ' });
  assert.equal(r.canSubmit, false);
  assert.equal(r.fallback, undefined);
});
