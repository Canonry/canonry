// SQLite 13 ships ABI-stable Node-API binaries inside its npm tarball. Inspect
// that published artifact; GitHub's per-Node-ABI release assets no longer exist.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

try {
  const lock = fs.readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  const versions = [...new Set([...lock.matchAll(/^ {2}better-sqlite3@(\d+\.\d+\.\d+):$/gm)].map(match => match[1]))]
  if (versions.length !== 1) throw new Error(`Expected one locked better-sqlite3 version, got ${versions.join(', ')}`)
  const version = versions[0]
  const metadata = await fetch(`https://registry.npmjs.org/better-sqlite3/${version}`, { signal: AbortSignal.timeout(30_000) })
  if (!metadata.ok) throw new Error(`npm metadata: HTTP ${metadata.status}`)
  const pkg = await metadata.json()
  const response = await fetch(pkg.dist.tarball, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`npm tarball: HTTP ${response.status}`)
  const entries = new Set(execFileSync('tar', ['-tzf', '-'], {
    input: Buffer.from(await response.arrayBuffer()), encoding: 'utf8', timeout: 30_000,
  }).trim().split('\n'))
  const targets = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'linuxmusl-x64', 'linuxmusl-arm64', 'win32-x64', 'win32-arm64']
  const missing = targets.filter(target => !entries.has(`package/prebuilds/${target}.node`))
  if (missing.length) {
    console.error(`better-sqlite3 ${version} is missing native binaries: ${missing.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`better-sqlite3 ${version}: all ${targets.length} supported platform binaries are published (Node-API).`)
  }
} catch (error) {
  console.error(`Could not complete the prebuild check: ${error.message}`)
  process.exitCode = 2
}
