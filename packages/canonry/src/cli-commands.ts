import type { CliCommandSpec } from './cli-dispatch.js'
import { BACKFILL_CLI_COMMANDS } from './cli-commands/backfill.js'
import { BACKLINKS_CLI_COMMANDS } from './cli-commands/backlinks.js'
import { BING_CLI_COMMANDS } from './cli-commands/bing.js'
import { CDP_CLI_COMMANDS } from './cli-commands/cdp.js'
import { GA_CLI_COMMANDS } from './cli-commands/ga.js'
import { COMPETITOR_CLI_COMMANDS } from './cli-commands/competitor.js'
import { GOOGLE_CLI_COMMANDS } from './cli-commands/google.js'
import { KEYWORD_CLI_COMMANDS } from './cli-commands/keyword.js'
import { NOTIFY_CLI_COMMANDS } from './cli-commands/notify.js'
import { OPERATOR_CLI_COMMANDS } from './cli-commands/operator.js'
import { PROJECT_CLI_COMMANDS } from './cli-commands/project.js'
import { RUN_CLI_COMMANDS } from './cli-commands/run.js'
import { SCHEDULE_CLI_COMMANDS } from './cli-commands/schedule.js'
import { SETTINGS_CLI_COMMANDS } from './cli-commands/settings.js'
import { SNAPSHOT_CLI_COMMANDS } from './cli-commands/snapshot.js'
import { INTELLIGENCE_CLI_COMMANDS } from './cli-commands/intelligence.js'
import { SYSTEM_CLI_COMMANDS } from './cli-commands/system.js'
import { WORDPRESS_CLI_COMMANDS } from './cli-commands/wordpress.js'
import { AGENT_CLI_COMMANDS } from './cli-commands/agent.js'

export const REGISTERED_CLI_COMMANDS: readonly CliCommandSpec[] = [
  ...BACKFILL_CLI_COMMANDS,
  ...BACKLINKS_CLI_COMMANDS,
  ...SYSTEM_CLI_COMMANDS,
  ...PROJECT_CLI_COMMANDS,
  ...KEYWORD_CLI_COMMANDS,
  ...COMPETITOR_CLI_COMMANDS,
  ...SETTINGS_CLI_COMMANDS,
  ...SNAPSHOT_CLI_COMMANDS,
  ...RUN_CLI_COMMANDS,
  ...OPERATOR_CLI_COMMANDS,
  ...SCHEDULE_CLI_COMMANDS,
  ...NOTIFY_CLI_COMMANDS,
  ...GOOGLE_CLI_COMMANDS,
  ...BING_CLI_COMMANDS,
  ...WORDPRESS_CLI_COMMANDS,
  ...CDP_CLI_COMMANDS,
  ...GA_CLI_COMMANDS,
  ...INTELLIGENCE_CLI_COMMANDS,
  ...AGENT_CLI_COMMANDS,
]
