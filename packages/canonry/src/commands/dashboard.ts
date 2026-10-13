import fs from 'node:fs'
import { anyUsersExist } from '@ainyc/canonry-api-routes'
import { createClient } from '@ainyc/canonry-db'
import { clearDashboardPassword, loadConfigRaw } from '../config.js'
import { isMachineFormat } from '../cli-error.js'

/**
 * Whether this install signs in with named accounts, which replace the shared
 * dashboard password (`namedAccountsInUse` in `server.ts`). False when the
 * database cannot be read, so the answer falls back to a shared-password
 * install.
 */
function namedAccountsInUse(): boolean {
  const database = loadConfigRaw()?.database
  if (typeof database !== 'string' || !fs.existsSync(database)) return false
  try {
    const db = createClient(database)
    try {
      return anyUsersExist(db)
    } finally {
      db.$client.close()
    }
  } catch {
    // Not migrated yet, or unreadable.
    return false
  }
}

function nextStepsFor(cleared: boolean, namedAccounts: boolean): string[] {
  if (namedAccounts) {
    return [
      'This install signs in with named accounts, so the shared dashboard password is not used and clearing it does not change who can sign in.',
      'To restore an account, run "canonry user list", then "canonry user delete <name>" and "canonry user create".',
    ]
  }
  if (!cleared) {
    return ['If the dashboard still asks for a password, restart the server: it keeps the password it started with.']
  }
  return [
    'Restart the server to apply the reset. Until then it still accepts the old password.',
    // First-run setup on a loopback bind takes the password from any process
    // that can open a loopback connection (docs/deployment.md).
    'Then open the dashboard and create the new password right away. Until one is set, a server that listens only on this machine accepts it from any local connection, so stop any port forwarder (ssh -R, ngrok tcp, tailscale serve --tcp) first.',
  ]
}

export async function resetDashboardPassword(opts: { format?: string }): Promise<void> {
  const { cleared, configPath } = clearDashboardPassword()
  const namedAccounts = namedAccountsInUse()
  const nextSteps = nextStepsFor(cleared, namedAccounts)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({
      reset: cleared,
      configPath,
      restartRequired: cleared && !namedAccounts,
      namedAccounts,
      nextSteps,
    }, null, 2))
    return
  }

  console.log(cleared
    ? `Dashboard password cleared from ${configPath}.`
    : `No dashboard password is set in ${configPath}; nothing to reset.`)
  for (const step of nextSteps) console.log(step)
}
