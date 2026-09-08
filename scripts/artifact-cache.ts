import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Snapshot = Record<string, string>
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** File contents, including additions and deletions; mtimes never establish freshness. */
export function snapshotDirectory(root: string, preserve: string[] = []): Snapshot {
  const result = Object.create(null) as Snapshot
  const walk = (dir: string, ancestors: Set<string>) => {
    const real = fs.realpathSync(dir)
    if (ancestors.has(real)) throw new Error(`Directory cycle: ${dir}`)
    const next = new Set([...ancestors, real])
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const relative = path.relative(root, file).split(path.sep).join('/')
      if (preserve.some(entry => relative === entry || relative.startsWith(`${entry}/`))) continue
      const stat = fs.statSync(file)
      if (stat.isDirectory()) walk(file, next)
      else if (stat.isFile()) result[relative] = digest(fs.readFileSync(file))
      else throw new Error(`Unsupported artifact input: ${file}`)
    }
  }
  if (fs.existsSync(root)) walk(root, new Set())
  return result
}

export function fingerprint(inputs: string[], extra: unknown = null): string {
  const hash = createHash('sha256').update(JSON.stringify(extra))
  for (const input of [...new Set(inputs)].sort()) {
    hash.update(JSON.stringify(input))
    if (!fs.existsSync(input)) hash.update('missing')
    else if (fs.statSync(input).isDirectory()) hash.update(JSON.stringify(snapshotDirectory(input)))
    else hash.update(digest(fs.readFileSync(input)))
  }
  return hash.digest('hex')
}

/** Copy only changed files. Preserved trees (for example agent assets) stay untouched. */
export function syncDirectory(source: string, target: string, preserve: string[] = []): void {
  const expected = snapshotDirectory(source, preserve)
  const actual = snapshotDirectory(target, preserve)
  for (const file of Object.keys(actual)) {
    if (!Object.hasOwn(expected, file)) fs.rmSync(path.join(target, file))
  }
  for (const [file, hash] of Object.entries(expected)) {
    if (actual[file] === hash) continue
    const destination = path.join(target, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) fs.rmSync(destination, { recursive: true })
    fs.copyFileSync(path.join(source, file), destination)
  }
}

export async function runArtifactTask(options: {
  inputHash: string
  outputDir: string
  cacheFile: string
  check?: boolean
  force?: boolean
  generate: (outputDir: string) => Promise<void>
}): Promise<{ cached: boolean; changedFiles: string[] }> {
  const { inputHash, outputDir, cacheFile } = options
  const actual = snapshotDirectory(outputDir)
  let cached: { inputHash?: string; outputHash?: string } = {}
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as typeof cached
  } catch {
    // Missing or invalid cache state causes a fresh generation.
  }
  if (!options.force && cached?.inputHash === inputHash && cached.outputHash === digest(JSON.stringify(actual)) && Object.keys(actual).length > 0) {
    return { cached: true, changedFiles: [] }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-artifact-'))
  const generated = path.join(temp, 'output')
  fs.mkdirSync(generated)
  try {
    await options.generate(generated)
    const expected = snapshotDirectory(generated)
    if (Object.keys(expected).length === 0) throw new Error('Generation produced no output files')
    const current = snapshotDirectory(outputDir)
    const changedFiles = [...new Set([...Object.keys(expected), ...Object.keys(current)])]
      .filter(file => expected[file] !== current[file]).sort()
    if (options.check && changedFiles.length > 0) {
      throw new Error(`Generated output differs (${changedFiles.length} files):\n${changedFiles.slice(0, 20).join('\n')}`)
    }
    if (!options.check) syncDirectory(generated, outputDir)
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    const cacheTemp = `${cacheFile}.${randomUUID()}.tmp`
    fs.writeFileSync(cacheTemp, JSON.stringify({ inputHash, outputHash: digest(JSON.stringify(expected)) }))
    fs.renameSync(cacheTemp, cacheFile)
    return { cached: false, changedFiles }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
