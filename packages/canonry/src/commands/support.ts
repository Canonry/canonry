import { CANONRY_COMMUNITY_LINKS } from '@canonry/canonry-contracts'
import { isMachineFormat, type CliFormat } from '../cli-error.js'
import { CANONRY_ISSUES_URL, isManagedCanonryInstall } from '../support-links.js'

const FEEDBACK_COMMAND = 'canonry feedback "<what happened>"'

export function supportCommand(format?: CliFormat): void {
  const { discord, x, youtube } = CANONRY_COMMUNITY_LINKS
  const socialLinks = isManagedCanonryInstall() ? undefined : { x, youtube }
  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      discord,
      issues: CANONRY_ISSUES_URL,
      feedbackCommand: FEEDBACK_COMMAND,
      ...socialLinks,
    }, null, 2))
    return
  }
  console.log([
    'Get help with Canonry:',
    `  Discord:   ${discord}`,
    `  Issues:    ${CANONRY_ISSUES_URL}`,
    `  From here: ${FEEDBACK_COMMAND}`,
    ...(socialLinks ? [
      '',
      'Follow Canonry:',
      `  X:         ${socialLinks.x}`,
      `  YouTube:   ${socialLinks.youtube}`,
    ] : []),
  ].join('\n'))
}
