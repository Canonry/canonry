import { getPlatformEnv } from '@canonry/canonry-config'

export function loadApiEnv(source: NodeJS.ProcessEnv) {
  return getPlatformEnv(source)
}
