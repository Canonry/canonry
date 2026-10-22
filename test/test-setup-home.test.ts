import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const setupFile = path.join(repoRoot, 'test-setup/vitest-defaults.ts')
const vitestCli = path.join(repoRoot, 'node_modules/vitest/vitest.mjs')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// Where corepack keeps the package managers it downloads, in the order its
// getCorepackHomeFolder() reads: COREPACK_HOME, then XDG_CACHE_HOME or
// LOCALAPPDATA, then a cache folder under the home directory.
function corepackHome(env: NodeJS.ProcessEnv, home: string): string {
  const cache = env.XDG_CACHE_HOME ?? env.LOCALAPPDATA ?? path.join(home, process.platform === 'win32' ? 'AppData/Local' : '.cache')
  return env.COREPACK_HOME ?? path.join(cache, 'node', 'corepack')
}

function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

test('each test file gets a throwaway home, but corepack downloads stay outside it', () => {
  const home = os.homedir()
  expect(path.basename(home)).toMatch(/^canonry-test-home-/)
  // Inside the throwaway home, every test file that runs pnpm through corepack
  // would download the pinned pnpm again.
  expect(isInside(home, corepackHome(process.env, home))).toBe(false)
})

// Runs a one-test file under the shared setup in a separate Vitest whose temp
// directory is `tmp`, and returns the home and config directories it used.
function runUnderSetup(env: Record<string, string | undefined>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-setup-fixture-'))
  tempDirs.push(root)
  const tmp = path.join(root, 'tmp')
  const record = path.join(root, 'seen.json')
  fs.mkdirSync(tmp)
  fs.writeFileSync(path.join(root, 'vitest.config.mjs'), `export default ${JSON.stringify({
    cacheDir: path.join(root, 'cache'),
    test: { globals: true, include: ['fixture.test.mjs'], setupFiles: [setupFile] },
  })}\n`)
  fs.writeFileSync(path.join(root, 'fixture.test.mjs'), [
    "import fs from 'node:fs'",
    "import os from 'node:os'",
    "import path from 'node:path'",
    "test('writes into its home and config directories', () => {",
    "  fs.writeFileSync(path.join(os.homedir(), 'note.txt'), 'x')",
    "  fs.writeFileSync(path.join(process.env.CANONRY_CONFIG_DIR, 'config.yaml'), 'apiUrl: http://localhost:4100\\n')",
    `  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ home: os.homedir(), config: process.env.CANONRY_CONFIG_DIR }))`,
    '})',
    // A file's own afterAll, like a server closing, still finds its directories.
    "afterAll(() => fs.writeFileSync(path.join(os.homedir(), 'closed.txt'), 'x'))",
    '',
  ].join('\n'))
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...env })) {
    if (value !== undefined && !key.startsWith('VITEST')) childEnv[key] = value
  }
  const result = spawnSync(process.execPath, [vitestCli, 'run', '--root', root, '--config', path.join(root, 'vitest.config.mjs')], {
    cwd: root, env: childEnv, encoding: 'utf8',
  })
  const output = `${result.stdout}${result.stderr}`
  if (!fs.existsSync(record)) throw new Error(`The fixture did not run (exit ${result.status}):\n${output}`)
  const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { home: string, config: string }
  const leftovers = fs.readdirSync(tmp).filter(name => /^canonry-test-(?:home|config)-/.test(name))
  return { status: result.status, output, tmp, seen, leftovers }
}

test('the setup removes the home and config directories it created when the test file finishes', () => {
  const run = runUnderSetup({ CANONRY_CONFIG_DIR: undefined })
  expect(run.status, run.output).toBe(0)
  expect(path.dirname(run.seen.home)).toBe(run.tmp)
  expect(path.dirname(run.seen.config)).toBe(run.tmp)
  expect(run.leftovers).toEqual([])
}, 60_000)

test('the setup keeps a CANONRY_CONFIG_DIR it did not create', () => {
  const callerConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-caller-config-'))
  tempDirs.push(callerConfig)
  const run = runUnderSetup({ CANONRY_CONFIG_DIR: callerConfig })
  expect(run.status, run.output).toBe(0)
  expect(run.seen.config).toBe(callerConfig)
  expect(fs.readFileSync(path.join(callerConfig, 'config.yaml'), 'utf8')).toBe('apiUrl: http://localhost:4100\n')
  expect(run.leftovers).toEqual([])
}, 60_000)
