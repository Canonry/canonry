import type { PlatformEnv } from '@ainyc/aeo-platform-config'

export function createHeartbeatLog(env: PlatformEnv): string {
  return [
    '[worker]',
    'heartbeat',
    `database=${env.databaseUrl ? 'configured' : 'missing'}`,
    `geminiConcurrency=${env.providerQuota.maxConcurrency}`,
  ].join(' ')
}
