import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

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
