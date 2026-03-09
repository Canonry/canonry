import { getPlatformEnv } from '@ainyc/aeo-platform-config'

export function loadApiEnv(source: NodeJS.ProcessEnv) {
  return getPlatformEnv(source)
}
