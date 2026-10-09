import { clearDashboardPassword } from '../config.js'
import { isMachineFormat } from '../cli-error.js'

export async function resetDashboardPassword(opts: { format?: string }): Promise<void> {
  const { cleared, configPath } = clearDashboardPassword()

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({
      reset: cleared,
      configPath,
      restartRequired: cleared,
    }, null, 2))
    return
  }

  if (!cleared) {
    console.log(`No dashboard password is set in ${configPath}; nothing to reset.`)
    return
  }

  console.log(`Dashboard password cleared from ${configPath}.`)
  console.log('Restart the local server — it will show the first-run setup screen again next launch.')
}
