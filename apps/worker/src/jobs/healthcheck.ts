import type { PlatformEnv } from '@ainyc/aeo-platform-config'

export function createHeartbeatLog(env: PlatformEnv): string {
  const providerCount = Object.keys(env.providers).length
  return [
    '[worker]',
    'heartbeat',
    `database=${env.databaseUrl ? 'configured' : 'missing'}`,
    `providers=${providerCount}`,
  ].join(' ')
}
