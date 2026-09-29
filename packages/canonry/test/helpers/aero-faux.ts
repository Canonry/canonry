import { fauxProvider, type FauxProviderHandle, type RegisterFauxProviderOptions } from '@earendil-works/pi-ai'
import { aeroModels } from '../../src/agent/pi-models.js'

/**
 * A scripted pi-ai provider that Aero can stream through. pi-ai 0.80 replaced
 * the global `registerFauxProvider` with a provider handle that only works
 * once it is added to a model collection, so this adds it to `aeroModels`,
 * the collection `aeroStreamFn` and `completeOnce` use, and removes it again
 * with `unregister()`.
 */
export type AeroFaux = FauxProviderHandle & { unregister(): void }

export function registerAeroFaux(options: RegisterFauxProviderOptions): AeroFaux {
  const faux = fauxProvider(options)
  aeroModels.setProvider(faux.provider)
  return Object.assign(faux, { unregister: () => aeroModels.deleteProvider(faux.provider.id) })
}
