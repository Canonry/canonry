import type { CliCommandSpec } from './cli-dispatch.js'
import { BING_CLI_COMMANDS } from './cli-commands/bing.js'
import { CDP_CLI_COMMANDS } from './cli-commands/cdp.js'
import { COMPETITOR_CLI_COMMANDS } from './cli-commands/competitor.js'
import { GOOGLE_CLI_COMMANDS } from './cli-commands/google.js'
import { KEYWORD_CLI_COMMANDS } from './cli-commands/keyword.js'
import { NOTIFY_CLI_COMMANDS } from './cli-commands/notify.js'
import { OPERATOR_CLI_COMMANDS } from './cli-commands/operator.js'
import { PROJECT_CLI_COMMANDS } from './cli-commands/project.js'
import { RUN_CLI_COMMANDS } from './cli-commands/run.js'
import { SCHEDULE_CLI_COMMANDS } from './cli-commands/schedule.js'
import { SETTINGS_CLI_COMMANDS } from './cli-commands/settings.js'
import { SYSTEM_CLI_COMMANDS } from './cli-commands/system.js'

export const REGISTERED_CLI_COMMANDS: readonly CliCommandSpec[] = [
  ...SYSTEM_CLI_COMMANDS,
  ...PROJECT_CLI_COMMANDS,
  ...KEYWORD_CLI_COMMANDS,
  ...COMPETITOR_CLI_COMMANDS,
  ...SETTINGS_CLI_COMMANDS,
  ...RUN_CLI_COMMANDS,
  ...OPERATOR_CLI_COMMANDS,
  ...SCHEDULE_CLI_COMMANDS,
  ...NOTIFY_CLI_COMMANDS,
  ...GOOGLE_CLI_COMMANDS,
  ...BING_CLI_COMMANDS,
  ...CDP_CLI_COMMANDS,
]
