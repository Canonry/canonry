import { getPlatformEnv } from '@ainyc/canonry-config'

export function loadApiEnv(source: NodeJS.ProcessEnv) {
  return getPlatformEnv(source)
}
