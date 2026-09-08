import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, runArtifactTask } from '../../scripts/artifact-cache.js'

const webRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(webRoot, '../..')

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--force')) throw new Error('Usage: build.ts [--force]')
  const inputs = [
    ...['src', 'public', 'index.html', 'vite.config.ts', 'build.ts', 'tsconfig.json', 'package.json'].map(file => path.join(webRoot, file)),
    ...[webRoot, repoRoot].flatMap(dir => fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^(?:\.env|\.postcssrc|\.browserslistrc|(?:vite|postcss|tailwind|tsconfig|browserslist)[.-])/.test(entry.name))
      .map(entry => path.join(dir, entry.name))),
    ...['pnpm-lock.yaml', 'package.json', 'tsconfig.base.json', 'scripts/artifact-cache.ts', 'packages/canonry/THIRD_PARTY_NOTICES.md'].map(file => path.join(repoRoot, file)),
  ]
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
    inputHash: fingerprint(inputs, { env, node: process.version, platform: process.platform, arch: process.arch }),
    outputDir: path.join(webRoot, 'dist'),
    cacheFile: path.join(repoRoot, '.tmp/web-build/cache.json'),
    force: args.includes('--force'),
    generate: async (outputDir) => {
      const { build } = await import('vite')
      await build({ root: webRoot, build: { outDir: outputDir, emptyOutDir: true } })
    },
  })
  console.log(result.cached ? 'Web build unchanged (cached)' : 'Web build complete')
}

main().catch(error => {
  console.error('Web build failed:', error)
  process.exitCode = 1
})
