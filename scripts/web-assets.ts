import fs from 'node:fs'
import path from 'node:path'
import { syncDirectory } from './artifact-cache.js'

export function copyWebAssets(webDistDir: string, assetsDir: string): number {
  const html = fs.readFileSync(path.join(webDistDir, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]!)
  const missing = refs.filter(ref => !fs.existsSync(path.join(webDistDir, ref)))
  if (missing.length > 0) throw new Error(`Web build references missing assets: ${missing.join(', ')}`)
  syncDirectory(webDistDir, assetsDir, ['agent-workspace'])
  return refs.length
}
