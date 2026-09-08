import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function hash(parts) {
  const digest = createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.from(part)
    digest.update(`${bytes.length}:`).update(bytes)
  }
  return digest.digest('hex')
}

function readInputs(root) {
  if (!fs.existsSync(root)) return ['missing']
  if (!fs.statSync(root).isDirectory()) return [fs.readFileSync(root)]
  return fs.readdirSync(root).sort().flatMap(name => [name, ...readInputs(path.join(root, name))])
}

// Syntax lint depends on the file, its effective config, and the rule code.
// Never use this cache for type-aware rules: another file can change its types.
export function createLintCache(cwd, commonDir) {
  const cacheRoot = process.env.CANONRY_LINT_CACHE_DIR
    ?? path.join(os.tmpdir(), `canonry-lint-cache-${process.getuid?.() ?? os.userInfo().username}`)
  const directory = path.join(cacheRoot, hash([fs.realpathSync(commonDir)]), 'v1')
  const inputs = [process.version, process.platform, process.arch]
  for (const file of [
    'package.json', 'pnpm-lock.yaml', 'eslint-rules',
    ...fs.readdirSync(cwd).filter(name => /^eslint\.config\./.test(name)).sort(),
  ]) inputs.push(file, ...readInputs(path.join(cwd, file)))
  // Include the installed versions as well as the lockfile, so a stale install
  // cannot serve results from a different parser or plugin version.
  for (const name of [
    'eslint', '@eslint/js', 'typescript-eslint', 'typescript', 'globals',
    'eslint-plugin-regexp', 'eslint-plugin-react-hooks',
  ]) inputs.push(name, fs.readFileSync(new URL(import.meta.resolve(`${name}/package.json`))))
  inputs.push(fs.readFileSync(new URL(import.meta.url)), fs.readFileSync(new URL('./lint-changed.mjs', import.meta.url)))
  const inputHash = hash(inputs)

  return {
    key(file, source, config) {
      try {
        // Only this parser path is portable; type checking is disabled. Retain
        // other absolute config paths so path-sensitive settings cannot collide.
        const serialized = JSON.stringify(config, (key, value) => key === 'tsconfigRootDir' && value === cwd ? '<worktree>' : value)
        return hash([inputHash, file, source, serialized])
      } catch {
        return undefined // An uncacheable config must still be linted.
      }
    },
    has(key) {
      if (!key) return false
      try {
        return fs.readFileSync(path.join(directory, key.slice(0, 2), key), 'utf8') === `${key}\n`
      } catch {
        return false
      }
    },
    put(key) {
      if (!key) return
      const parent = path.join(directory, key.slice(0, 2))
      const temporary = path.join(parent, `${key}.${randomUUID()}.tmp`)
      try {
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
        fs.writeFileSync(temporary, `${key}\n`, { flag: 'wx', mode: 0o600 })
        // Independent, immutable entries avoid lost updates between worktrees.
        fs.renameSync(temporary, path.join(parent, key))
      } catch {
        // Cache storage is optional. Read-only disks must not block a commit.
      } finally {
        try { fs.rmSync(temporary, { force: true }) } catch { /* Best-effort cleanup. */ }
      }
    },
  }
}
