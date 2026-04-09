import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let _cached: string | undefined

/**
 * Read the version from the nearest `package.json` (apps/api/package.json).
 * Falls back to `'0.1.0'` if the file cannot be read.
 */
export function getApiVersion(): string {
  if (_cached) return _cached
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json')
    const raw = readFileSync(pkgPath, 'utf8')
    _cached = JSON.parse(raw).version as string
  } catch {
    _cached = '0.1.0'
  }
  return _cached
}
