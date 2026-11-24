'use strict';

import type { ToolProvider } from '../../core/providers/types';
import { isT3CodeProcess } from '../../core/detection/tool-detection';

// Discord shows the application name and icon from this application. The large
// image is T3 Code's own 512px icon (Nightly gets its Nightly icon) until an
// uploaded asset replaces it.
export const DEFAULT_T3_CLIENT_ID = '';
export const DEFAULT_T3_IMAGE_KEY = 'https://raw.githubusercontent.com/pingdotgg/t3code/main/assets/prod/t3-black-web-icon-512x512.png';
export const DEFAULT_T3_NIGHTLY_IMAGE_KEY = 'https://raw.githubusercontent.com/pingdotgg/t3code/main/assets/nightly/nightly-web-icon-512x512.png';

export const t3DesktopProvider: ToolProvider = {
  id: 't3App',
  family: 't3',
  presence: {
    key: 't3App',
    details: 'Using T3 Code',
    state: 'T3 Code',
    family: 't3'
  },
  process: {
    surface: 'desktop',
    priority: 30,
    familyOrder: 62,
    matches: isT3CodeProcess
  },
  setup: {
    name: 'T3 Code',
    order: 95,
    probe: {
      kind: 'desktop',
      macCandidates: [
        { bundleName: 'T3 Code.app' },
        { bundleName: 'T3 Code (Nightly).app' },
        { bundleName: 'T3 Code (Beta).app' }
      ],
      windowsStartNames: ['T3 Code (Nightly)', 'T3 Code (Beta)', 'T3 Code']
    }
  },
  discord: {
    application: 't3',
    label: 'T3 Code',
    defaultClientId: DEFAULT_T3_CLIENT_ID,
    clientIdEnvironment: 'DISCORD_CODING_STATUS_T3_CLIENT_ID',
    defaultImageKey: DEFAULT_T3_IMAGE_KEY,
    imageKeyEnvironment: 'DISCORD_CODING_STATUS_T3_IMAGE_KEY'
  }
};

export const t3ConfigProvider: ToolProvider = {
  id: 't3Home',
  family: 't3',
  setup: {
    name: 'T3 config',
    order: 96,
    probe: {
      kind: 'path',
      defaultPath: '~/.t3'
    }
  }
};

export const t3Providers: readonly ToolProvider[] = [
  t3DesktopProvider,
  t3ConfigProvider
];
