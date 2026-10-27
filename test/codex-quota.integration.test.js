'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
} = require('./helpers');

async function startUsageServer(t, responseDelayMs = 0) {
  const requests = [];
  let responseStatus = 200;
  let usedPercent = 45;
  const server = http.createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      accountId: request.headers['chatgpt-account-id'],
      url: request.url
    });

    setTimeout(() => {
      response.writeHead(responseStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: usedPercent,
            limit_window_seconds: 604800
          },
          secondary_window: null
        }
      }));
    }, responseDelayMs);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    respondWith(status, nextUsedPercent = usedPercent) {
      responseStatus = status;
      usedPercent = nextUsedPercent;
    }
  };
}

function writeTestAuth(directory) {
  const authFile = path.join(directory, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: {
      access_token: 'test-access-token',
      account_id: 'test-account-id'
    }
  }));
  return authFile;
}

test('OAuth quota labels the current primary 7-day window as weekly', async (t) => {
  const { directory, env } = createTestEnvironment(t);
  const usageServer = await startUsageServer(t);
  const authFile = writeTestAuth(directory);
  const result = await runCli(['quota', '--source', 'oauth'], {
    ...env,
    DISCORD_CODING_STATUS_CODEX_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_CODEX_API_BASE_URL: usageServer.baseUrl
  });

  assert.equal(result.stdout.trim(), 'Pro • weekly 55%');
  assert.equal(usageServer.requests.length, 1);
  const expectedAuth = `Bearer ${JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.access_token}`;
  assert.equal(usageServer.requests[0].authorization, expectedAuth);
  assert.equal(usageServer.requests[0].accountId, 'test-account-id');
  assert.equal(usageServer.requests[0].url, '/wham/usage');
});

test('hook updates reach Discord immediately and make no quota request', async (t) => {
  const { directory, env, rpcLogFile } = createTestEnvironment(t);
  const usageServer = await startUsageServer(t, 2000);
  const authFile = writeTestAuth(directory);
  const daemonEnv = {
    ...env,
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: 'oauth',
    DISCORD_CODING_STATUS_CODEX_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_CODEX_API_BASE_URL: usageServer.baseUrl,
    DISCORD_CODING_STATUS_USAGE_TIMEOUT_MS: '5000'
  };
  const daemon = startDaemon(t, daemonEnv);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  await runCli([
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', 'slow-quota-session',
    '--cwd', process.cwd(),
    '--model', 'gpt-no-quota',
    '--activity', 'Non-blocking quota verification'
  ], daemonEnv);

  const hookActivity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details === 'Model: gpt-no-quota'
    ),
    'the hook model to reach Discord without waiting for quota',
    1200
  );

  assert.equal(hookActivity.clientId, '1517375602662051900');
  assert.equal(hookActivity.activity.state, undefined);
  assert.equal(usageServer.requests.length, 0, 'presence must not request quota');
  assert.doesNotMatch(
    readRpcEvents(rpcLogFile).map((event) => JSON.stringify(event.activity || {})).join('\n'),
    /Pro •|weekly|Non-blocking quota verification/
  );
  assert.equal(daemon.output().stderr, '');
});

test('presence stays model-only while the usage endpoint is unavailable', async (t) => {
  const { directory, env, rpcLogFile } = createTestEnvironment(t);
  const usageServer = await startUsageServer(t);
  const authFile = writeTestAuth(directory);
  const daemonEnv = {
    ...env,
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: 'oauth',
    DISCORD_CODING_STATUS_CODEX_AUTH_FILE: authFile,
    DISCORD_CODING_STATUS_CODEX_API_BASE_URL: usageServer.baseUrl,
    DISCORD_CODING_STATUS_POLL_INTERVAL_MS: '50',
    DISCORD_CODING_STATUS_USAGE_REFRESH_INTERVAL_MS: '100'
  };
  const daemon = startDaemon(t, daemonEnv);

  await waitFor(
    () => daemon.output().stdout.includes('for hook updates'),
    'the daemon state watcher to start'
  );

  const commonArgs = [
    'hook',
    '--tool', 'codex',
    '--surface', 'cli',
    '--status', 'running',
    '--session-id', 'quota-cache-session',
    '--cwd', process.cwd()
  ];
  await runCli([...commonArgs, '--model', 'gpt-outage-proof'], daemonEnv);

  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details === 'Model: gpt-outage-proof'
    ),
    'the model line to reach Discord'
  );

  usageServer.respondWith(503);
  await runCli([...commonArgs, '--model', 'gpt-outage-proof-2'], daemonEnv);
  const cachedActivity = await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details === 'Model: gpt-outage-proof-2'
    ),
    'the model line to keep updating during the outage'
  );
  assert.equal(cachedActivity.activity.state, undefined);

  usageServer.respondWith(200, 60);
  await runCli([...commonArgs, '--model', 'gpt-recovered'], daemonEnv);
  await waitFor(
    () => readRpcEvents(rpcLogFile).find(
      (event) => event.method === 'setActivity'
        && event.activity.details === 'Model: gpt-recovered'
    ),
    'the model line to keep updating after recovery'
  );

  assert.equal(usageServer.requests.length, 0, 'presence must not request quota');
  assert.doesNotMatch(
    readRpcEvents(rpcLogFile).map((event) => JSON.stringify(event.activity || {})).join('\n'),
    /Pro •|weekly/
  );
});
