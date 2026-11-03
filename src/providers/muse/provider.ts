'use strict';

import type { ToolProvider } from '../../core/providers/types';
import { isMuseProcess } from '../../core/detection/tool-detection';

// No shared public Discord application exists for Muse Code: create one
// named "Muse Code" in the Discord developer portal and set its client ID via
// DISCORD_CODING_STATUS_MUSE_CLIENT_ID (config file or environment). The
// empty default keeps the daemon running; Muse presence stays off until set.
export const DEFAULT_MUSE_CLIENT_ID = '1564448755250372688';
export const DEFAULT_MUSE_IMAGE_KEY = 'https://github.com/meta-llama.png';

export const museCliProvider: ToolProvider = {
  id: 'museCli',
  family: 'muse',
  presence: {
    key: 'museCli',
    details: 'Using Muse',
    state: 'Muse Code',
    family: 'muse'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 55,
    matches: isMuseProcess
  },
  setup: {
    name: 'Muse',
    order: 85,
    probe: {
      kind: 'executable',
      candidates: ['muse']
    }
  },
  hooks: ['muse'],
  discord: {
    application: 'muse',
    label: 'Muse Code',
    defaultClientId: DEFAULT_MUSE_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_MUSE_CLIENT_ID',

    imageKeyEnvironment: 'DISCORD_CODING_STATUS_MUSE_IMAGE_KEY'
  }
};

export const museConfigProvider: ToolProvider = {
  id: 'museHome',
  family: 'muse',
  setup: {
    name: 'Muse sessions',
    order: 86,
    probe: {
      kind: 'path',
      defaultPath: '~/.local/share/muse/sessions'
    }
  }
};

export const museProviders: readonly ToolProvider[] = [
  museCliProvider,
  museConfigProvider
];
