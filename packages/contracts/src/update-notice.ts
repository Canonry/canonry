/**
 * Shared vocabulary for the "newer canonry is available" notice shown by the
 * CLI, doctor, `/health`, and MCP. Every string an agent may act on (the
 * upgrade command, the package URL) is built HERE from a closed enum, never
 * taken from a remote payload, so a server can at most pick which of these
 * fixed instructions an agent sees.
 */

export const CANONRY_NPM_PACKAGE = '@canonry/canonry'
export const CANONRY_NPM_PACKAGE_URL = `https://www.npmjs.com/package/${CANONRY_NPM_PACKAGE}`

export const INSTALL_METHODS = ['npm', 'homebrew', 'docker'] as const
export type InstallMethod = (typeof INSTALL_METHODS)[number]

export function isInstallMethod(value: unknown): value is InstallMethod {
  return typeof value === 'string' && (INSTALL_METHODS as readonly string[]).includes(value)
}

export function upgradeCommandFor(method: InstallMethod): string {
  switch (method) {
    case 'npm': return `npm install -g ${CANONRY_NPM_PACKAGE}`
    case 'homebrew': return 'brew upgrade canonry'
    case 'docker': return 'pull or rebuild your canonry image, then recreate the container'
  }
}

/**
 * A one-sentence caveat for install methods whose upgrade can lag the npm
 * release, or null. The Homebrew tap is bumped only after npm publishes, so
 * for a short window `brew upgrade` reports canonry as already current.
 */
export function upgradeCaveatFor(method: InstallMethod): string | null {
  switch (method) {
    case 'homebrew': return 'Homebrew can trail npm briefly; if brew says canonry is up to date, retry later.'
    case 'npm':
    case 'docker':
      return null
  }
}

export type UpdateCheckEnvOptOut = 'CANONRY_DISABLE_UPDATE_CHECK' | 'DO_NOT_TRACK' | 'CI'

/**
 * The environment opt-out that silences update checks and notices, in
 * precedence order, or null. Every surface (CLI, server, stdio MCP) consults
 * this, so the "Silence with CANONRY_DISABLE_UPDATE_CHECK=1" the notice
 * advertises works wherever the variable is set.
 */
export function updateCheckEnvOptOut(env: Readonly<Record<string, string | undefined>>): UpdateCheckEnvOptOut | null {
  if (env.CANONRY_DISABLE_UPDATE_CHECK === '1') return 'CANONRY_DISABLE_UPDATE_CHECK'
  if (env.DO_NOT_TRACK === '1') return 'DO_NOT_TRACK'
  if (env.CI) return 'CI'
  return null
}
