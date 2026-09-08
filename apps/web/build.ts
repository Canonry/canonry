import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { InlineConfig } from 'vite'
import { fingerprint, runArtifactTask } from '../../scripts/artifact-cache.js'

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(webRoot, '../..')

function cachedOptions(args: string[]): InlineConfig | undefined {
  try {
    // Vite accepts --sourcemap with an optional value. Normalize the bare flag
    // before Node's parser, which requires either a boolean or a string type.
    const normalized = args.map((arg, i) => arg === '--sourcemap' && (!args[i + 1] || args[i + 1]!.startsWith('-')) ? '--sourcemap=true' : arg)
    const { values } = parseArgs({
      args: normalized,
      options: {
        mode: { type: 'string', short: 'm' },
        base: { type: 'string' },
        sourcemap: { type: 'string' },
      },
    })
    let sourcemap: boolean | 'inline' | 'hidden' | undefined
    if (values.sourcemap === 'true') sourcemap = true
    else if (values.sourcemap === 'false') sourcemap = false
    else if (values.sourcemap === 'inline' || values.sourcemap === 'hidden') sourcemap = values.sourcemap
    else if (values.sourcemap !== undefined) return undefined
    return { mode: values.mode, base: values.base, build: { sourcemap } }
  } catch {
    // Let Vite parse its other options, including watch, SSR, and output paths.
    return undefined
  }
}

async function main() {
  const args = process.argv.slice(2)
  const viteArgs = args.filter(arg => arg !== '--force')
  const options = cachedOptions(viteArgs)
  if (!options) {
    const viteBin = fileURLToPath(new URL('bin/vite.js', import.meta.resolve('vite/package.json')))
    execFileSync(process.execPath, [viteBin, 'build', ...viteArgs], { cwd: webRoot, stdio: 'inherit' })
    return
  }
  const { build, resolveConfig } = await import('vite')
  const inline = { ...options, root: webRoot }
  const config = await resolveConfig(inline, 'build', 'production', 'production')
  const inputs = [
    ...['src', 'public', 'index.html', 'vite.config.ts', 'build.ts', 'tsconfig.json', 'package.json'].map(file => path.join(webRoot, file)),
    ...[webRoot, repoRoot].flatMap(dir => fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && /^(?:\.env|\.postcssrc|\.browserslistrc|(?:vite|postcss|tailwind|tsconfig|browserslist)[.-])/.test(entry.name))
      .map(entry => path.join(dir, entry.name))),
    ...['pnpm-lock.yaml', 'package.json', 'tsconfig.base.json', 'scripts/artifact-cache.ts', 'packages/canonry/THIRD_PARTY_NOTICES.md'].map(file => path.join(repoRoot, file)),
    ...config.configFileDependencies,
  ]
  const envDir = config.envDir
  if (envDir !== false) {
    inputs.push(...['.env', '.env.local', `.env.${config.mode}`, `.env.${config.mode}.local`].map(file => path.join(envDir, file)))
  }
  // Follow declared workspace runtime dependencies, including their own dependencies.
  const packages = new Map<string, { dir: string; dependencies?: Record<string, string> }>()
  for (const name of fs.readdirSync(path.join(repoRoot, 'packages'))) {
    const dir = path.join(repoRoot, 'packages', name)
    const manifest = path.join(dir, 'package.json')
    if (!fs.existsSync(manifest)) continue
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name: string; dependencies?: Record<string, string> }
    packages.set(pkg.name, { dir, ...pkg })
  }
  const visited = new Set<string>()
  const visit = (dependencies: Record<string, string> = {}) => {
    for (const name of Object.keys(dependencies).sort()) {
      const pkg = packages.get(name)
      if (!pkg || visited.has(name)) continue
      visited.add(name)
      inputs.push(...['src', 'dist', 'package.json', 'tsconfig.json'].map(file => path.join(pkg.dir, file)))
      visit(pkg.dependencies)
    }
  }
  visit((JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies)
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith('VITE_') || ['NODE_ENV', 'BROWSERSLIST', 'BROWSERSLIST_ENV', 'CANONRY_API_URL'].includes(key)).sort())
  const result = await runArtifactTask({
    // Vite expands .env values against process.env and follows env symlinks.
    // Hash the resolved values, not only raw VITE_* process variables.
    inputHash: fingerprint(inputs, { env, resolvedEnv: config.env, options, node: process.version, platform: process.platform, arch: process.arch }),
    outputDir: path.resolve(config.root, config.build.outDir),
    cacheFile: path.join(repoRoot, '.tmp/web-build/cache.json'),
    force: args.includes('--force'),
    generate: async (outputDir) => {
      await build({ ...inline, build: { ...inline.build, outDir: outputDir, emptyOutDir: true } })
    },
  })
  console.log(result.cached ? 'Web build unchanged (cached)' : 'Web build complete')
}

main().catch(error => {
  console.error('Web build failed:', error)
  process.exitCode = 1
})
