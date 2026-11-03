'use strict';

import type { ActivityStyle, ConfigEditorField } from './types';

export const DEFAULT_DETAIL_LEVEL = 'project';
export const DEFAULT_CODEX_QUOTA_SOURCE = 'oauth';
export const DEFAULT_CODEX_AUTH_FILE = '~/.codex/auth.json';
export const DEFAULT_CLAUDE_CONFIG_DIR = '~/.claude';
export const DEFAULT_ACTIVITY_STYLE: ActivityStyle = 'fun';

export const JSON_CONFIG_ALIASES: Record<string, string> = {
  codexClientId: 'DISCORD_CODING_STATUS_CODEX_CLIENT_ID',
  claudeClientId: 'DISCORD_CODING_STATUS_CLAUDE_CLIENT_ID',
  opencodeClientId: 'DISCORD_CODING_STATUS_OPENCODE_CLIENT_ID',
  piClientId: 'DISCORD_CODING_STATUS_PI_CLIENT_ID',
  museClientId: 'DISCORD_CODING_STATUS_MUSE_CLIENT_ID',
  grokClientId: 'DISCORD_CODING_STATUS_GROK_CLIENT_ID',
  cursorClientId: 'DISCORD_CODING_STATUS_CURSOR_CLIENT_ID',
  antigravityClientId: 'DISCORD_CODING_STATUS_ANTIGRAVITY_CLIENT_ID',
  clientId: 'DISCORD_CLIENT_ID',
  detailLevel: 'DISCORD_CODING_STATUS_DETAIL_LEVEL',
  quotaSource: 'DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE',
  codexAuthFile: 'DISCORD_CODING_STATUS_CODEX_AUTH_FILE',
  stateFile: 'DISCORD_CODING_STATUS_STATE_FILE',
  claudeImageKey: 'DISCORD_CODING_STATUS_CLAUDE_IMAGE_KEY',
  codexImageKey: 'DISCORD_CODING_STATUS_CODEX_IMAGE_KEY',
  largeImageKey: 'DISCORD_LARGE_IMAGE_KEY',
  smallImageKey: 'DISCORD_SMALL_IMAGE_KEY',
  planText: 'DISCORD_CODING_STATUS_PLAN_TEXT',
  limitsText: 'DISCORD_CODING_STATUS_LIMITS_TEXT',
  preferCodexCli: 'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
  showActivity: 'DISCORD_CODING_STATUS_SHOW_ACTIVITY',
  showProject: 'DISCORD_CODING_STATUS_SHOW_PROJECT',
  showModel: 'DISCORD_CODING_STATUS_SHOW_MODEL',
  showQuota: 'DISCORD_CODING_STATUS_SHOW_QUOTA',
  showContext: 'DISCORD_CODING_STATUS_SHOW_CONTEXT',
  activityStyle: 'DISCORD_CODING_STATUS_ACTIVITY_STYLE',
  showPackage: 'DISCORD_CODING_STATUS_SHOW_PACKAGE'
};

export const ENV_CONFIG_ALIASES = Object.fromEntries(
  Object.entries(JSON_CONFIG_ALIASES).map(([alias, envName]) => [envName, alias])
) as Record<string, string>;

export const BOOLEAN_CONFIG_KEYS = new Set([
  'DISCORD_CODING_STATUS_PREFER_CODEX_CLI',
  'DISCORD_CODING_STATUS_SHOW_ACTIVITY',
  'DISCORD_CODING_STATUS_SHOW_PROJECT',
  'DISCORD_CODING_STATUS_SHOW_MODEL',
  'DISCORD_CODING_STATUS_SHOW_QUOTA',
  'DISCORD_CODING_STATUS_SHOW_CONTEXT',
  'DISCORD_CODING_STATUS_SHOW_PACKAGE'
]);

export interface ConfigEditorApplication {
  label: string;
  clientIdEnvironment: string;
  clientId: string;
}

// Only settings that change something. Discord shows the tool's application
// name and one model line, so display, detail-level and activity-style
// settings are not offered.
export function createConfigEditorFields(
  defaultStateFile: string,
  applications: readonly ConfigEditorApplication[]
): ConfigEditorField[] {
  return [
    ...applications.map((application) => ({
      key: application.clientIdEnvironment,
      label: `${application.label} Discord application ID`,
      defaultValue: application.clientId
    })),
    {
      key: 'DISCORD_CODING_STATUS_STATE_FILE',
      label: 'State file',
      defaultValue: defaultStateFile
    },
    {
      key: 'DISCORD_CODING_STATUS_CODEX_QUOTA_SOURCE',
      label: 'Codex quota source (quota command)',
      defaultValue: DEFAULT_CODEX_QUOTA_SOURCE,
      choices: ['oauth', 'auto', 'rpc', 'off']
    },
    {
      key: 'DISCORD_CODING_STATUS_CODEX_AUTH_FILE',
      label: 'Codex auth file (quota command)',
      defaultValue: DEFAULT_CODEX_AUTH_FILE
    }
  ];
}
