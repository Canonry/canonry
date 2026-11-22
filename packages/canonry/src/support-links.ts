export const CANONRY_ISSUES_URL = 'https://github.com/Canonry/canonry/issues'

export function isManagedCanonryInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CANONRY_RUNTIME_MODE?.trim().toLowerCase() === 'cloud'
}
