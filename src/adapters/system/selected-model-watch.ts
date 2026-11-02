'use strict';

import * as fs from 'node:fs';

// Watches ONLY the currently selected positively bound model file (today: the
// Muse headless exec session log returned by readMuseExecModelForProcess).
// No global transcript inference, no directory scans. Hook tools already
// trigger via the state watcher; this covers bound process-model changes with
// no new focus event.

const DEBOUNCE_MS = 50;

let watchedFile: string | null = null;
let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let changeCallback: (() => void) | null = null;

function clearDebounce(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

export function unwatchSelectedModelFile(): void {
  clearDebounce();

  if (watcher) {
    try {
      watcher.close();
    } catch (_) {
      // Best effort cleanup.
    }
    watcher = null;
  }

  watchedFile = null;
  changeCallback = null;
}

export function watchSelectedModelFile(file: string | null, onChange: () => void): void {
  if (!file) {
    unwatchSelectedModelFile();
    return;
  }

  if (file === watchedFile && watcher) {
    changeCallback = onChange;
    return;
  }

  unwatchSelectedModelFile();

  try {
    const next = fs.watch(file, (eventType) => {
      clearDebounce();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (eventType === 'rename' && watchedFile === file && changeCallback) {
          const cb = changeCallback;
          unwatchSelectedModelFile();
          watchSelectedModelFile(file, cb);
        }
        try {
          changeCallback?.();
        } catch (_) {
          // Listener errors must never break the watcher.
        }
      }, DEBOUNCE_MS);
    });

    next.on('error', () => {
      unwatchSelectedModelFile();
    });

    watcher = next;
    watchedFile = file;
    changeCallback = onChange;
  } catch (_) {
    // Fail closed: the slow census still refreshes the model on its next pass.
    unwatchSelectedModelFile();
  }
}

export function getWatchedModelFile(): string | null {
  return watchedFile;
}

export function resetSelectedModelWatchForTests(): void {
  unwatchSelectedModelFile();
}
