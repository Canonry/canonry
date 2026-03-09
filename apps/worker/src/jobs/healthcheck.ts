import type { PlatformEnv } from '@ainyc/aeo-platform-config'

export function createHeartbeatLog(env: PlatformEnv): string {
  return [
    '[worker]',
    'phase-1 skeleton heartbeat',
    `database=${env.databaseUrl ? 'configured' : 'missing'}`,
    `geminiConcurrency=${env.providerQuota.maxConcurrency}`,
  ].join(' ')
}
