import { createHash } from 'node:crypto'
import { retryAfterDelayMs, type ModelDefinition } from '@ainyc/canonry-contracts'
import type { ProviderRegistry } from './provider-registry.js'

const TTL_MS = 60 * 60 * 1000
const RETRY_MS = 60 * 1000
const TIMEOUT_MS = 3000

/** Per-install, per-credential cache. Discovery never changes an execution default. */
export function createProviderModelCatalog(registry: ProviderRegistry) {
  const cache = new Map<string, { identity: string; models?: ModelDefinition[]; expiresAt: number; pending?: Promise<ModelDefinition[]> }>()
  return async (name: string): Promise<ModelDefinition[]> => {
    const provider = registry.get(name)
    if (!provider) { cache.delete(name); return [] }
    const fallback = provider.adapter.modelRegistry.knownModels
    if (!provider.adapter.listModels) return fallback
    const identity = createHash('sha256').update(JSON.stringify(provider.config)).digest('hex')
    let entry = cache.get(name)
    if (entry?.identity !== identity) {
      entry = { identity, expiresAt: 0 }
      cache.set(name, entry)
    }
    if (entry.pending) return entry.pending
    if (entry.expiresAt > Date.now()) return entry.models ?? fallback
    const current = entry
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Model discovery timed out')) }, TIMEOUT_MS)
    })
    current.pending = Promise.race([
      Promise.resolve().then(() => provider.adapter.listModels!(provider.config, controller.signal)),
      deadline,
    ]).then(models => {
      const usableModels = [...new Map(models.filter(model => model.id.trim()).map(model => [model.id, model])).values()]
        .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))
      if (!usableModels.length) throw new Error('Empty model catalog')
      current.models = usableModels
      current.expiresAt = Date.now() + TTL_MS
      return current.models
    }).catch((error: unknown) => {
      current.expiresAt = Date.now() + Math.max(RETRY_MS, retryAfterDelayMs(error) ?? 0)
      return current.models ?? fallback
    }).finally(() => {
      clearTimeout(timer)
      current.pending = undefined
    })
    return current.pending
  }
}
