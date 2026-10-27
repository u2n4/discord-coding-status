'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const RPC_MOCK = path.join(__dirname, 'fixtures', 'mock-discord-rpc.cjs');

function isTmpPath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    const tmp = path.resolve(os.tmpdir());
    const target = path.resolve(value);
    if (process.platform === 'win32') {
      const lowerTmp = tmp.toLowerCase();
      const lowerTarget = target.toLowerCase();
      return lowerTarget === lowerTmp || lowerTarget.startsWith(lowerTmp + path.sep);
    }
    return target === tmp || target.startsWith(tmp + path.sep);
  } catch (_) {
    return false;
  }
}

function createTestEnvironment(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-'));
  const stateFile = path.join(directory, 'states.json');
  const rpcLogFile = path.join(directory, 'rpc.jsonl');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${RPC_MOCK}`]
    .filter(Boolean)
    .join(' ');
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    NODE_OPTIONS: nodeOptions,
    DISCORD_CLIENT_ID: '',
    DISCORD_CODING_STATUS_DETAIL_LEVEL: 'full',
    DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE: 'off',
    DISCORD_CODING_STATUS_ACTIVITY_STYLE: 'fun',
    DISCORD_CODING_STATUS_SHOW_ACTIVITY: 'true',
    DISCORD_CODING_STATUS_SHOW_PROJECT: 'true',
    DISCORD_CODING_STATUS_SHOW_MODEL: 'true',
    DISCORD_CODING_STATUS_SHOW_QUOTA: 'true',
    DISCORD_CODING_STATUS_SHOW_CONTEXT: 'false',
    DISCORD_CODING_STATUS_SHOW_PACKAGE: 'false',
    DISCORD_CODING_STATUS_PROCESS_DETECTION: 'off',
    DISCORD_CODING_STATUS_POLL_INTERVAL_MS: '60000',
    DISCORD_CODING_STATUS_STATE_FILE: stateFile,
    DISCORD_CODING_STATUS_RPC_LOG_FILE: rpcLogFile,
    ...overrides
  };

  // Home/config/install isolation plus the daemon-lifecycle seam. Applied
  // AFTER overrides so a test can never silently point the suite back at the
  // live home, config, install dir, or scheduled task. An explicit override is
  // honored only when it already points inside the OS tmpdir (hook tests use a
  // second tmpdir for HOME); anything else, including values inherited from
  // process.env, is replaced with this test's own directory. The lifecycle
  // seam (dummy task name + skip flag) and the RPC/state paths are always
  // forced: no test has a reason to run the production lifecycle.
  const isolation = {
    HOME: directory,
    USERPROFILE: directory,
    LOCALAPPDATA: directory,
    APPDATA: directory,
    XDG_CONFIG_HOME: path.join(directory, '.config'),
    XDG_DATA_HOME: path.join(directory, '.local', 'share'),
    CODEX_HOME: path.join(directory, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, '.claude'),
    DISCORD_CODING_STATUS_CONFIG_DIR: path.join(directory, 'dcs-config'),
    DISCORD_CODING_STATUS_GROK_HOOKS_DIR: path.join(directory, 'grok-hooks')
  };
  for (const [key, isolated] of Object.entries(isolation)) {
    if (typeof env[key] === 'string' && env[key] && isTmpPath(env[key])) {
      continue;
    }
    env[key] = isolated;
  }
  env.NODE_OPTIONS = nodeOptions;
  env.DISCORD_CODING_STATUS_STATE_FILE = stateFile;
  env.DISCORD_CODING_STATUS_RPC_LOG_FILE = rpcLogFile;
  env.DISCORD_CODING_STATUS_TASK_NAME = `DCS-Test-${process.pid}`;
  env.DISCORD_CODING_STATUS_SKIP_DAEMON_RESTART = '1';

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, env, rpcLogFile, stateFile };
}

function runCli(args, env, timeoutMs = 15000, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(
        `CLI failed (${code ?? signal}): ${args.join(' ')}\n${stdout}\n${stderr}`
      ));
    });

    if (input !== null) {
      child.stdin.end(input);
    }
  });
}

function startDaemon(t, env) {
  const child = spawn(process.execPath, [CLI, 'daemon'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  return {
    child,
    output() {
      return { stdout, stderr };
    }
  };
}

function readRpcEvents(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }

  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

module.exports = {
  createTestEnvironment,
  readRpcEvents,
  runCli,
  startDaemon,
  waitFor
};
