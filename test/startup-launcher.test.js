'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseWindowsTaskActionTarget,
  preserveWindowsLaunchers,
  windowsLauncherPaths
} = require('../dist/adapters/startup/service');
const { rejectAfter } = require('../dist/presence');

const TASK_XML = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <Actions Context="Author">',
  '    <Exec>',
  '      <Command>wscript.exe</Command>',
  '      <Arguments>"C:\\Users\\aliha\\AppData\\Local\\discord-coding-status\\app\\discord-coding-status.vbs"</Arguments>',
  '    </Exec>',
  '  </Actions>',
  '</Task>',
  ''
].join('\n');

test('the task-target parser reads the VBS path from schtasks XML', () => {
  assert.equal(
    parseWindowsTaskActionTarget(TASK_XML),
    'C:\\Users\\aliha\\AppData\\Local\\discord-coding-status\\app\\discord-coding-status.vbs'
  );
  assert.equal(
    parseWindowsTaskActionTarget('<Exec><Arguments>&quot;C:\\a b\\c.vbs&quot;</Arguments></Exec>'),
    'C:\\a b\\c.vbs'
  );
  assert.equal(parseWindowsTaskActionTarget('<Task></Task>'), null);
  assert.equal(parseWindowsTaskActionTarget('not xml'), null);
  assert.equal(parseWindowsTaskActionTarget('<Arguments>   </Arguments>'), null);
});

test('launcher paths stay consistent between install, preserve, and status', () => {
  const installDirectory = path.join('C:\\App', 'discord-coding-status', 'app');
  assert.deepEqual(windowsLauncherPaths(installDirectory, 'discord-coding-status'), {
    commandPath: path.join(installDirectory, 'run-daemon.cmd'),
    hiddenPath: path.join(installDirectory, 'discord-coding-status.vbs')
  });
});

test('runtime replacement carries the Windows launchers across', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-launchers-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const installDirectory = path.join(scratch, 'app');
  const tempDirectory = path.join(scratch, 'app.tmp-1');
  fs.mkdirSync(tempDirectory, { recursive: true });
  const current = windowsLauncherPaths(installDirectory, 'discord-coding-status');
  fs.mkdirSync(installDirectory, { recursive: true });
  fs.writeFileSync(current.commandPath, '@echo off\r\n');
  fs.writeFileSync(current.hiddenPath, 'Set shell = CreateObject("WScript.Shell")\r\n');

  preserveWindowsLaunchers(installDirectory, tempDirectory, 'discord-coding-status');

  const next = windowsLauncherPaths(tempDirectory, 'discord-coding-status');
  assert.equal(fs.readFileSync(next.commandPath, 'utf8'), '@echo off\r\n');
  assert.match(fs.readFileSync(next.hiddenPath, 'utf8'), /WScript\.Shell/);
});

test('launcher preservation is a no-op when no launchers were installed', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-coding-status-launchers-empty-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const installDirectory = path.join(scratch, 'app');
  const tempDirectory = path.join(scratch, 'app.tmp-1');
  fs.mkdirSync(installDirectory, { recursive: true });
  fs.mkdirSync(tempDirectory, { recursive: true });

  preserveWindowsLaunchers(installDirectory, tempDirectory, 'discord-coding-status');
  assert.deepEqual(fs.readdirSync(tempDirectory), []);
});

test('rejectAfter still rejects after the timeout', async () => {
  await assert.rejects(rejectAfter(10, 'boom-message'), /boom-message/);
});

test('rejectAfter lets the caller release the timeout handle on success', async () => {
  let captured = null;
  const pending = rejectAfter(20, 'must not fire', (timer) => {
    captured = timer;
  });
  pending.catch(() => {});
  assert.ok(captured, 'expected the timer handle to be captured');
  clearTimeout(captured);

  await new Promise((resolve) => setTimeout(resolve, 60));

  let settled = false;
  pending.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, 'a cleared timeout must never settle the race');
});
