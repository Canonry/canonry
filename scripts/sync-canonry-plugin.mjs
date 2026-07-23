import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const managedSkills = ['aero', 'canonry']
const pluginRoot = path.join(repoRoot, 'plugins', 'canonry')
const packageManifestPath = path.join(repoRoot, 'packages', 'canonry', 'package.json')
const rootManifestPath = path.join(repoRoot, 'package.json')
const pluginManifestPaths = [
  path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
  path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
]

function parseArgs(args) {
  let checkOnly = false
  let baseRef

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--check') {
      checkOnly = true
      continue
    }
    if (arg === '--base-ref') {
      baseRef = args[index + 1]
      index += 1
      if (!baseRef) throw new Error('--base-ref requires a git ref')
      continue
    }
    if (arg.startsWith('--base-ref=')) {
      baseRef = arg.slice('--base-ref='.length)
      if (!baseRef) throw new Error('--base-ref requires a git ref')
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (baseRef && !checkOnly) {
    throw new Error('--base-ref is only supported with --check')
  }

  return { baseRef, checkOnly }
}

const { baseRef, checkOnly } = parseArgs(process.argv.slice(2))

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function walkFiles(dir, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(absolute, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function compareTrees(source, target) {
  if (!fs.existsSync(target)) return [`missing directory: ${path.relative(repoRoot, target)}`]
  const sourceFiles = walkFiles(source)
  const targetFiles = walkFiles(target)
  const problems = []
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
    const sourceSet = new Set(sourceFiles)
    const targetSet = new Set(targetFiles)
    for (const file of sourceFiles.filter((item) => !targetSet.has(item))) problems.push(`missing: ${file}`)
    for (const file of targetFiles.filter((item) => !sourceSet.has(item))) problems.push(`unexpected: ${file}`)
  }
  for (const file of sourceFiles.filter((item) => targetFiles.includes(item))) {
    if (hashFile(path.join(source, file)) !== hashFile(path.join(target, file))) {
      problems.push(`changed: ${file}`)
    }
  }
  return problems
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function readJsonAtRef(ref, relativePath) {
  try {
    return JSON.parse(runGit(['show', `${ref}:${relativePath}`]))
  } catch {
    return undefined
  }
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return undefined
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.'),
  }
}

function compareSemver(left, right) {
  const leftVersion = parseSemver(left)
  const rightVersion = parseSemver(right)
  if (!leftVersion || !rightVersion) return undefined

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] > rightVersion.core[index] ? 1 : -1
    }
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0
  if (!leftVersion.prerelease) return 1
  if (!rightVersion.prerelease) return -1

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = /^\d+$/.test(leftIdentifier)
    const rightNumeric = /^\d+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) > Number(rightIdentifier) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier > rightIdentifier ? 1 : -1
  }

  return 0
}

function checkVersionAdvancement(ref, failures) {
  let mergeBase
  try {
    const resolvedRef = runGit(['rev-parse', '--verify', `${ref}^{commit}`])
    mergeBase = runGit(['merge-base', resolvedRef, 'HEAD'])
  } catch {
    failures.push(`cannot resolve git comparison base "${ref}"; fetch the base commit before running plugin:check`)
    return
  }

  let changedFiles
  try {
    changedFiles = runGit([
      'diff',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      mergeBase,
      '--',
      'skills',
      'plugins/canonry',
    ]).split('\n').filter(Boolean)
  } catch {
    failures.push(`cannot compare plugin paths with merge base ${mergeBase}`)
    return
  }

  if (changedFiles.length === 0) return

  const versionFiles = [rootManifestPath, packageManifestPath, ...pluginManifestPaths]
  for (const filePath of versionFiles) {
    const relativePath = path.relative(repoRoot, filePath)
    const baseManifest = readJsonAtRef(mergeBase, relativePath)
    if (!baseManifest) continue

    const currentVersion = readJson(filePath).version
    const comparison = compareSemver(currentVersion, baseManifest.version)
    if (comparison === undefined) {
      failures.push(`${relativePath} has a non-semver version (${baseManifest.version} -> ${currentVersion})`)
    } else if (comparison <= 0) {
      failures.push(
        `${relativePath} version must advance beyond ${baseManifest.version} because plugin inputs changed: ${changedFiles.join(', ')}`,
      )
    }
  }
}

const packageVersion = readJson(packageManifestPath).version
const rootVersion = readJson(rootManifestPath).version
const failures = []

if (rootVersion !== packageVersion) {
  failures.push(`root package version ${rootVersion} does not match @canonry/canonry ${packageVersion}`)
}

for (const manifestPath of pluginManifestPaths) {
  const manifest = readJson(manifestPath)
  if (checkOnly) {
    if (manifest.version !== packageVersion) {
      failures.push(`${path.relative(repoRoot, manifestPath)} version ${manifest.version} does not match ${packageVersion}`)
    }
  } else if (manifest.version !== packageVersion) {
    manifest.version = packageVersion
    writeJson(manifestPath, manifest)
  }
}

for (const skill of managedSkills) {
  const source = path.join(repoRoot, 'skills', skill)
  const target = path.join(pluginRoot, 'skills', skill)
  if (checkOnly) {
    const problems = compareTrees(source, target)
    for (const problem of problems) failures.push(`${skill}: ${problem}`)
  } else {
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true })
  }
}

if (checkOnly && baseRef) {
  checkVersionAdvancement(baseRef, failures)
}

if (failures.length > 0) {
  process.stderr.write(`Canonry plugin drift detected:\n- ${failures.join('\n- ')}\n`)
  process.exitCode = 1
} else if (checkOnly) {
  process.stdout.write(`Canonry plugin matches v${packageVersion}.\n`)
} else {
  process.stdout.write(`Synced Canonry plugin skills and manifests to v${packageVersion}.\n`)
}
