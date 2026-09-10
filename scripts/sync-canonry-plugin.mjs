import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncAgentOperations } from './sync-agent-operations.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const managedSkills = ['aero', 'canonry']
const pluginRoot = path.join(repoRoot, 'plugins', 'canonry')
const packageManifestPath = path.join(repoRoot, 'packages', 'canonry', 'package.json')
const rootManifestPath = path.join(repoRoot, 'package.json')
const portablePluginManifestPath = path.join(pluginRoot, 'plugin.json')
const portableMcpPath = path.join(pluginRoot, 'mcp.json')
const legacyMcpPath = path.join(pluginRoot, '.mcp.json')
const clientPluginManifestPaths = [
  path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
  path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
]
const pluginManifestPaths = [portablePluginManifestPath, ...clientPluginManifestPaths]
const portablePluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const portableMcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
const portablePluginFields = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])
const sharedPluginFields = [
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
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
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+[0-9a-z.-]+)?$/i.exec(version)
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

function validatePortablePlugin(failures) {
  const manifest = readJson(portablePluginManifestPath)
  if (!isPlainObject(manifest)) {
    failures.push('plugins/canonry/plugin.json must contain a JSON object')
    return
  }
  if (manifest.$schema !== portablePluginSchema) {
    failures.push(`plugins/canonry/plugin.json must target ${portablePluginSchema}`)
  }
  if (manifest.name !== 'canonry' || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name)) {
    failures.push('plugins/canonry/plugin.json must declare name "canonry"')
  }
  for (const field of Object.keys(manifest)) {
    if (!portablePluginFields.has(field)) {
      failures.push(`plugins/canonry/plugin.json contains non-portable field "${field}"`)
    }
  }
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') {
      failures.push(`plugins/canonry/plugin.json field "${field}" must be a string`)
    }
  }
  if (manifest.version !== undefined && !parseSemver(manifest.version)) {
    failures.push('plugins/canonry/plugin.json version must use Semantic Versioning')
  }
  if (manifest.author !== undefined) {
    const authorFields = isPlainObject(manifest.author) ? Object.keys(manifest.author) : []
    if (
      !isPlainObject(manifest.author)
      || authorFields.some((field) => !['name', 'email', 'url'].includes(field))
      || Object.values(manifest.author).some((value) => typeof value !== 'string')
    ) {
      failures.push('plugins/canonry/plugin.json author must contain only string name, email, and url fields')
    }
  }
  if (manifest.keywords !== undefined && (
    !Array.isArray(manifest.keywords)
    || manifest.keywords.some((keyword) => typeof keyword !== 'string')
  )) {
    failures.push('plugins/canonry/plugin.json keywords must be an array of strings')
  }
  if (manifest.extensions !== undefined && (
    !isPlainObject(manifest.extensions)
    || Object.values(manifest.extensions).some((extension) => !isPlainObject(extension))
  )) {
    failures.push('plugins/canonry/plugin.json extensions must map namespaces to objects')
  }

  const mcp = readJson(portableMcpPath)
  if (!isPlainObject(mcp)) {
    failures.push('plugins/canonry/mcp.json must contain a JSON object')
    return
  }
  if (mcp.$schema !== portableMcpSchema) {
    failures.push(`plugins/canonry/mcp.json must target ${portableMcpSchema}`)
  }
  const mcpFields = Object.keys(mcp)
  if (mcpFields.some((field) => field !== '$schema' && field !== 'mcpServers')) {
    failures.push('plugins/canonry/mcp.json may contain only "$schema" and "mcpServers"')
  }
  const canonryServer = isPlainObject(mcp.mcpServers) ? mcp.mcpServers.canonry : undefined
  if (
    !isPlainObject(mcp.mcpServers)
    || Object.keys(mcp.mcpServers).length !== 1
    || !isPlainObject(canonryServer)
    || Object.keys(canonryServer).some((field) => !['type', 'command', 'args'].includes(field))
    || canonryServer.type !== 'stdio'
    || canonryServer.command !== 'canonry-mcp'
    || !Array.isArray(canonryServer.args)
    || canonryServer.args.some((arg) => typeof arg !== 'string')
  ) {
    failures.push('plugins/canonry/mcp.json must declare the canonry-mcp stdio server')
  }
}

function syncClientAdapters(failures) {
  const portableManifest = readJson(portablePluginManifestPath)
  if (!isPlainObject(portableManifest)) return
  for (const manifestPath of clientPluginManifestPaths) {
    const manifest = readJson(manifestPath)
    if (!isPlainObject(manifest)) {
      failures.push(`${path.relative(repoRoot, manifestPath)} must contain a JSON object`)
      continue
    }
    let changed = false
    for (const field of sharedPluginFields) {
      if (jsonEqual(manifest[field], portableManifest[field])) continue
      if (checkOnly) {
        failures.push(`${path.relative(repoRoot, manifestPath)} field "${field}" does not match portable plugin.json`)
      } else if (portableManifest[field] === undefined) {
        delete manifest[field]
        changed = true
      } else {
        manifest[field] = portableManifest[field]
        changed = true
      }
    }
    if (!checkOnly && changed) writeJson(manifestPath, manifest)
  }

  const portableMcp = readJson(portableMcpPath)
  if (
    !isPlainObject(portableMcp)
    || !isPlainObject(portableMcp.mcpServers)
    || Object.values(portableMcp.mcpServers).some((server) => !isPlainObject(server))
  ) {
    return
  }
  const expectedLegacyMcp = {
    mcpServers: Object.fromEntries(Object.entries(portableMcp.mcpServers).map(([name, server]) => {
      const { type: _type, ...legacyServer } = server
      return [name, legacyServer]
    })),
  }
  const legacyMcpMatches = fs.existsSync(legacyMcpPath) && jsonEqual(readJson(legacyMcpPath), expectedLegacyMcp)
  if (checkOnly && !legacyMcpMatches) {
    failures.push('plugins/canonry/.mcp.json does not match portable mcp.json')
  } else if (!checkOnly && !legacyMcpMatches) {
    writeJson(legacyMcpPath, expectedLegacyMcp)
  }
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
const failures = syncAgentOperations(repoRoot, checkOnly)

validatePortablePlugin(failures)

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

syncClientAdapters(failures)

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

function checkCodemap(failures) {
  const codemapPath = path.join(repoRoot, 'docs', 'CODEMAP.md')
  if (!fs.existsSync(codemapPath)) {
    failures.push('docs/CODEMAP.md is missing — run pnpm plugin:sync to regenerate the file index')
    return
  }
  const content = fs.readFileSync(codemapPath, 'utf8')
  const requiredEntries = [
    { file: 'packages/api-routes/src/visibility-attribution.ts', marker: 'visibility-attribution' },
    { file: 'packages/canonry/src/gsc-sitemap-submission.ts', marker: 'gsc-sitemap-submission' },
    { file: 'docs/GUARDS.md', marker: 'GUARDS.md' },
    { file: 'docs/DOC_UPDATE.md', marker: 'DOC_UPDATE.md' },
  ]
  for (const { file, marker } of requiredEntries) {
    if (!content.includes(marker)) {
      failures.push(`docs/CODEMAP.md missing entry for ${file} — run pnpm plugin:sync or update CODEMAP.md`)
    }
    if (!fs.existsSync(path.join(repoRoot, file))) {
      failures.push(`CODEMAP entry ${file} points to missing file`)
    }
  }
  if (!content.includes('find apps packages -type f -name')) {
    failures.push('docs/CODEMAP.md missing regenerate note — add: find apps packages -type f -name')
  }
}

checkCodemap(failures)

if (checkOnly && baseRef) {
  checkVersionAdvancement(baseRef, failures)
}

if (failures.length > 0) {
  process.stderr.write(`Canonry plugin drift detected:\n- ${failures.join('\n- ')}\n`)
  process.exitCode = 1
} else if (checkOnly) {
  process.stdout.write(`Canonry plugin matches v${packageVersion}.\n`)
} else {
  process.stdout.write(`Synced Canonry plugin skills, portable core, and client adapters to v${packageVersion}.\n`)
}
