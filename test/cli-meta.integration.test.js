'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTestEnvironment,
  runCli
} = require('./helpers');

test('an empty CLI invocation prints project information and usage without starting the daemon', async (t) => {
  const { env } = createTestEnvironment(t);
  const result = await runCli([], env);

  assert.match(result.stdout, /Discord Coding Status \d+\.\d+\.\d+/);
  assert.match(result.stdout, /Shows the AI coding tool you are using, and its model, in your Discord status\./);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Author: @u2n4/);
  assert.match(result.stdout, /Website: https:\/\/github\.com\/u2n4\/discord-coding-status#readme/);
  assert.match(result.stdout, /Repository: https:\/\/github\.com\/u2n4\/discord-coding-status/);
  assert.match(result.stdout, /discord-coding-status setup/);
  assert.match(result.stdout, /Antigravity: \d+/);
  assert.doesNotMatch(result.stdout, /Starting Discord Coding Status daemon/);
  assert.equal(result.stderr, '');
});
