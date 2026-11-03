'use strict';

import { createColors } from 'picocolors';

const pc = createColors(Boolean(process.stdout?.isTTY && !process.env.NO_COLOR));

export interface ConfigCommandContext {
  appTitle: string;
  configFile: string;
  readExistingConfig: () => Record<string, string>;
  writeConfig: (entries: Record<string, string>, options?: { action?: 'save' | 'reset'; skipRestart?: boolean }) => void;
  serializeConfig: (entries: Record<string, string>) => string;
  compactEntries: (entries: Record<string, string>) => Record<string, string>;
  runEditor: (existing: Record<string, string>) => Promise<Record<string, string>>;
}

export async function runConfigCommand(
  command: string,
  args: Record<string, string | boolean>,
  context: ConfigCommandContext
): Promise<boolean> {
  if (!['config', 'configure'].includes(command)) {
    return false;
  }

  const existing = context.readExistingConfig();
  const skipRestart = Boolean(args['no-restart'] || args.no_restart);

  if (args.reset) {
    context.writeConfig({}, { action: 'reset', skipRestart });
    return true;
  }

  if (args.show || args.json) {
    console.log(context.serializeConfig(context.compactEntries(existing)).trim());
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(pc.red('✖ Config editor requires an interactive terminal. Use `config --show` or `config --reset` in scripts, or edit the config file.'));
    process.exitCode = 1;
    return true;
  }

  context.writeConfig(await context.runEditor(existing), { skipRestart });
  return true;
}
