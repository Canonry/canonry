/** Where people get help. One place, so the command, error hint and tests agree. */
export const CANONRY_DISCORD_URL = 'https://discord.gg/jnJ2H2z5Xh'
export const CANONRY_ISSUES_URL = 'https://github.com/Canonry/canonry/issues'

export function isManagedCanonryInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CANONRY_RUNTIME_MODE?.trim().toLowerCase() === 'cloud'
}
