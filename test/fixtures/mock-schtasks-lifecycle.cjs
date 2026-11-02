'use strict';

// Mock schtasks/powershell lifecycle for setup tests (loaded via NODE_OPTIONS
// --require, only by tests that opt in). Intercepts the Windows task binaries
// so `setup` can run end-to-end with ZERO real scheduled-task writes:
//
// - schtasks /Create      -> fails with "Access is denied." (forces the UAC
//                            elevation retry, exactly like the 10:44 incident)
// - powershell.exe *RunAs* -> fails with code ETIMEDOUT after recording its
//                            options (simulates the elevation bound firing; a
//                            real UAC hang cannot be exercised in a test)
// - schtasks /Query       -> succeeds (the previous task still exists, so the
//                            failure path must attempt a daemon restart)
// - schtasks /End, /Run   -> succeed
// - any other powershell  -> succeeds with empty output (the pre-copy daemon
//                            kill becomes a harmless no-op under the mock)
// - everything else       -> delegated to the real execFileSync (tool
//                            detection via where.exe keeps working)
//
// Every intercepted call is appended as one JSON line to the file named by
// MOCK_SCHTASKS_LOG: { file, args, timeout }. The variable is required;
// loading this fixture without it fails fast so a misconfigured test can
// never silently neutralize (or, worse, pass through to) the real binaries.

const fs = require('node:fs');
const childProcess = require('node:child_process');

const LOG_FILE = process.env.MOCK_SCHTASKS_LOG;
if (!LOG_FILE) {
  throw new Error('mock-schtasks-lifecycle requires MOCK_SCHTASKS_LOG to be set.');
}

const realExecFileSync = childProcess.execFileSync;

function basenameOf(value) {
  return String(value).toLowerCase().split(/[/\\]/).pop();
}

function isMockedBinary(file) {
  const base = basenameOf(file);
  return base === 'schtasks' || base === 'schtasks.exe'
    || base === 'powershell' || base === 'powershell.exe';
}

function record(file, args, options) {
  const entry = {
    file: basenameOf(file),
    args: Array.isArray(args) ? args.map(String) : [],
    timeout: options && typeof options.timeout === 'number' ? options.timeout : null
  };
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

function failWith(stderr, code) {
  const error = new Error(`Mocked lifecycle failure${code ? ` (${code})` : ''}: ${stderr}`);
  error.stderr = stderr;
  if (code) {
    error.code = code;
  }
  throw error;
}

childProcess.execFileSync = function mockedExecFileSync(file, args, options) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const normalizedOptions = Array.isArray(args) ? options : args;
  if (!isMockedBinary(file)) {
    if (Array.isArray(args)) {
      return realExecFileSync.call(this, file, args, options);
    }
    return realExecFileSync.call(this, file, args);
  }

  record(file, normalizedArgs, normalizedOptions);
  const base = basenameOf(file);
  const verbs = normalizedArgs.map((arg) => String(arg).toLowerCase());

  if (base === 'schtasks' || base === 'schtasks.exe') {
    if (verbs.includes('/create')) {
      failWith('Access is denied.');
    }
    if (verbs.includes('/query')) {
      return '<Task></Task>';
    }
    return '';
  }

  // powershell.exe: only the elevation retry carries RunAs; every other call
  // (the pre-copy daemon kill) succeeds quietly under the mock.
  if (normalizedArgs.some((arg) => String(arg).includes('RunAs'))) {
    failWith('', 'ETIMEDOUT');
  }
  return '';
};
