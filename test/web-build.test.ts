import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

const repo = path.resolve(import.meta.dirname, '..')
const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-web-build-'))
  temporary.push(root)
  const web = path.join(root, 'apps/web')
  const write = (file: string, value: string | Buffer) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
  }
  write('package.json', '{"type":"module"}')
  write('apps/web/package.json', '{"type":"module","dependencies":{}}')
  write('apps/web/index.html', '<html><body><script type="module" src="./src/main.ts"></script></body></html>')
  write('apps/web/src/main.ts', 'document.body.textContent = import.meta.env.VITE_API_KEY')
  write('apps/web/vite.config.ts', 'export default { base: "./", logLevel: "silent" }')
  write('apps/web/build.ts', fs.readFileSync(path.join(repo, 'apps/web/build.ts')))
  write('scripts/artifact-cache.ts', fs.readFileSync(path.join(repo, 'scripts/artifact-cache.ts')))
  fs.mkdirSync(path.join(root, 'packages'))
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  fs.symlinkSync(path.join(repo, 'apps/web/node_modules'), path.join(web, 'node_modules'), 'dir')
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('VITE_') && key !== 'NODE_ENV'))
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'build.ts', ...args], {
    cwd: web, env, encoding: 'utf8', timeout: 20_000,
  })
  const build = (...args: string[]) => {
    const result = run(...args)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    return result.stdout
  }
  const bundle = () => fs.readdirSync(path.join(web, 'dist/assets')).filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(web, 'dist/assets', file), 'utf8')).join('\n')
  return { root, web, write, env, run, build, bundle }
}

test('interpolated environment changes invalidate the build without changing .env bytes', () => {
  const f = fixture()
  f.write('apps/web/.env', 'VITE_API_KEY=${CANONRY_BUILD_TEST_VALUE}\n')
  f.env.CANONRY_BUILD_TEST_VALUE = 'build-test-alpha'
  f.build()
  expect(f.bundle()).toContain('build-test-alpha')
  expect(f.build()).toContain('(cached)')
  f.env.CANONRY_BUILD_TEST_VALUE = 'build-test-beta'
  expect(f.build()).not.toContain('(cached)')
  expect(f.bundle()).toContain('build-test-beta')
  expect(f.bundle()).not.toContain('build-test-alpha')
  expect(f.build()).toContain('(cached)')
}, 30_000)

test('symlinked environment files track target edits and link replacement', () => {
  const f = fixture()
  f.write('shared.env', 'VITE_API_KEY=symlink-test-alpha\n')
  fs.symlinkSync(path.join(f.root, 'shared.env'), path.join(f.web, '.env'))
  f.build()
  expect(f.build()).toContain('(cached)')
  f.write('shared.env', 'VITE_API_KEY=symlink-test-beta\n')
  expect(f.build()).not.toContain('(cached)')
  expect(f.bundle()).toContain('symlink-test-beta')
  f.write('replacement.env', 'VITE_API_KEY=symlink-test-gamma\n')
  fs.unlinkSync(path.join(f.web, '.env'))
  fs.symlinkSync(path.join(f.root, 'replacement.env'), path.join(f.web, '.env'))
  f.build()
  expect(f.bundle()).toContain('symlink-test-gamma')
}, 30_000)

test('mode, base, and sourcemap options affect output and cache identity', () => {
  const f = fixture()
  f.write('apps/web/.env.production', 'VITE_API_KEY=production-test-value\n')
  f.write('apps/web/.env.staging', 'VITE_API_KEY=staging-test-value\n')
  f.build('--mode', 'staging', '--base', '/preview/', '--sourcemap')
  expect(f.bundle()).toContain('staging-test-value')
  expect(fs.readFileSync(path.join(f.web, 'dist/index.html'), 'utf8')).toContain('/preview/assets/')
  expect(fs.readdirSync(path.join(f.web, 'dist/assets')).some(file => file.endsWith('.map'))).toBe(true)
  expect(f.build('-m', 'staging', '--base=/preview/', '--sourcemap=true')).toContain('(cached)')
  expect(f.build('-m', 'staging', '--base=/preview/', '--sourcemap=false')).not.toContain('(cached)')
  expect(f.bundle()).not.toContain('sourceMappingURL')
  expect(fs.readdirSync(path.join(f.web, 'dist/assets')).some(file => file.endsWith('.map'))).toBe(false)
  expect(f.build('--mode=production', '--base=./', '--sourcemap=false')).not.toContain('(cached)')
  expect(f.bundle()).toContain('production-test-value')
  expect(f.bundle()).not.toContain('sourceMappingURL')
  expect(fs.readdirSync(path.join(f.web, 'dist/assets')).some(file => file.endsWith('.map'))).toBe(false)
  expect(fs.readFileSync(path.join(f.web, 'dist/index.html'), 'utf8')).toContain('./assets/')
}, 30_000)

test('other Vite options retain native CLI behavior without touching the default cache', () => {
  const f = fixture()
  f.build()
  const cache = fs.readFileSync(path.join(f.root, '.tmp/web-build/cache.json'), 'utf8')
  f.build('--outDir', 'custom-dist', '--sourcemap', 'hidden')
  expect(fs.existsSync(path.join(f.web, 'custom-dist/index.html'))).toBe(true)
  expect(fs.readdirSync(path.join(f.web, 'custom-dist/assets')).some(file => file.endsWith('.map'))).toBe(true)
  expect(fs.readFileSync(path.join(f.root, '.tmp/web-build/cache.json'), 'utf8')).toBe(cache)
  expect(f.run('--not-a-vite-option').status).not.toBe(0)
}, 30_000)
