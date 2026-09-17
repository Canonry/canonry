import { CheckCategories, CheckScopes, CheckStatuses, compareSemver, isStrictSemver, upgradeCaveatFor } from '@ainyc/canonry-contracts'
import type { CheckDefinition } from '../types.js'

const versionCurrentCheck: CheckDefinition = {
  id: 'canonry.version.current',
  category: CheckCategories.config,
  scope: CheckScopes.global,
  title: 'Canonry version',
  run: (ctx) => {
    if (!ctx.getUpdateStatus) {
      return {
        status: CheckStatuses.skipped,
        code: 'version.status-unavailable',
        summary: 'This deployment does not report update status.',
      }
    }

    const status = ctx.getUpdateStatus()
    if (!status.enabled) {
      // No remediation on purpose: an opt-out such as DO_NOT_TRACK is a
      // deliberate operator choice, and agents act on remediation text.
      return {
        status: CheckStatuses.skipped,
        code: 'version.check-disabled',
        summary: `Update check is off (${status.disabledBy ?? 'opted out'}); running ${status.current}.`,
        details: { current: status.current, ...(status.disabledBy ? { disabledBy: status.disabledBy } : {}) },
      }
    }

    if (!status.latest || !isStrictSemver(status.latest)) {
      return {
        status: CheckStatuses.skipped,
        code: 'version.latest-unknown',
        summary: `Latest published version is not known yet (running ${status.current}).`,
        remediation: 'The npm registry has not been reached yet. Re-run doctor in a moment; offline hosts stay skipped.',
        details: { current: status.current },
      }
    }

    if (compareSemver(status.latest, status.current) > 0) {
      const caveat = upgradeCaveatFor(status.installMethod)
      return {
        status: CheckStatuses.warn,
        code: 'version.outdated',
        summary: `canonry ${status.latest} is available; this server runs ${status.current}.`,
        remediation: status.installMethod === 'docker'
          ? `Upgrade the container: ${status.upgradeCommand}.`
          : `Run \`${status.upgradeCommand}\`, then restart the server (\`canonry stop && canonry start\`, or restart \`canonry serve\`).${caveat ? ` ${caveat}` : ''}`,
        details: {
          current: status.current,
          latest: status.latest,
          installMethod: status.installMethod,
          upgradeCommand: status.upgradeCommand,
          url: status.url,
        },
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'version.current',
      // "latest" would overstate it: when the registry is unreachable this can
      // come from an older on-disk cache, which proves only that nothing newer is known.
      summary: `No newer canonry known (running ${status.current}; latest seen ${status.latest}).`,
      details: { current: status.current, latest: status.latest },
    }
  },
}

export const VERSION_CHECKS: readonly CheckDefinition[] = [versionCurrentCheck]
