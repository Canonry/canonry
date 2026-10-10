import { isMachineFormat, type CliFormat } from '../cli-error.js'
import { CANONRY_DISCORD_URL, CANONRY_ISSUES_URL } from '../support-links.js'

const FEEDBACK_COMMAND = 'canonry feedback "<what happened>"'

export function supportCommand(format?: CliFormat): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ discord: CANONRY_DISCORD_URL, issues: CANONRY_ISSUES_URL, feedbackCommand: FEEDBACK_COMMAND }, null, 2))
    return
  }
  console.log([
    'Get help with Canonry:',
    `  Discord:   ${CANONRY_DISCORD_URL}`,
    `  Issues:    ${CANONRY_ISSUES_URL}`,
    `  From here: ${FEEDBACK_COMMAND}`,
  ].join('\n'))
}
