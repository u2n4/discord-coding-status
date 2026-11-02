'use strict';

import type { ToolProvider } from '../../core/providers/types';
import { isAntigravityCliProcess, isAntigravityProcess } from '../../core/detection/tool-detection';

export const DEFAULT_ANTIGRAVITY_CLIENT_ID = '1558457305995939962';

export const antigravityDesktopProvider: ToolProvider = {
  id: 'antigravityApp',
  family: 'antigravity',
  presence: {
    key: 'antigravityApp',
    details: 'Using Antigravity',
    state: 'Antigravity',
    family: 'antigravity'
  },
  process: {
    surface: 'desktop',
    priority: 30,
    familyOrder: 58,
    matches: isAntigravityProcess
  },
  setup: {
    name: 'Antigravity',
    order: 88,
    probe: {
      kind: 'desktop',
      macCandidates: [
        { bundleName: 'Antigravity.app' }
      ],
      windowsStartNames: ['Antigravity']
    }
  },
  hooks: ['antigravity'],
  discord: {
    application: 'antigravity',
    label: 'Antigravity',
    defaultClientId: DEFAULT_ANTIGRAVITY_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_ANTIGRAVITY_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_ANTIGRAVITY_IMAGE_KEY'
  }
};

export const antigravityCliProvider: ToolProvider = {
  id: 'antigravityCli',
  family: 'antigravity',
  presence: {
    key: 'antigravityCli',
    details: 'Using Antigravity',
    state: 'Antigravity CLI',
    family: 'antigravity'
  },
  process: {
    surface: 'cli',
    priority: 10,
    familyOrder: 58,
    matches: isAntigravityCliProcess
  },
  setup: {
    name: 'Antigravity CLI',
    order: 88,
    probe: {
      kind: 'executable',
      candidates: ['agy']
    }
  },
  hooks: ['antigravity'],
  discord: {
    application: 'antigravity',
    label: 'Antigravity',
    defaultClientId: DEFAULT_ANTIGRAVITY_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_ANTIGRAVITY_CLIENT_ID',
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_ANTIGRAVITY_IMAGE_KEY'
  }
};

export const antigravityConfigProvider: ToolProvider = {
  id: 'antigravityHome',
  family: 'antigravity',
  hooks: ['antigravity'],
  setup: {
    name: 'Antigravity config',
    order: 89,
    probe: {
      kind: 'path',
      defaultPath: '~/.gemini/antigravity'
    }
  }
};

export const antigravityProviders: readonly ToolProvider[] = [
  antigravityDesktopProvider,
  antigravityCliProvider,
  antigravityConfigProvider
];
