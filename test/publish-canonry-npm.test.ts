import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
const realNpm = fs.realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim())
const script = fs.readFileSync(new URL('../scripts/publish-canonry-npm.mjs', import.meta.url), 'utf8')
const primary = '@canonry/canonry'
const compatibility = '@ainyc/canonry'
const version = '1.2.3'

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

interface Invocation {
  command: string
  args: string[]
  cwd: string
}

function fixture(artifactManifest = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-publisher-test-'))
  roots.push(root)
  for (const dir of ['scripts', 'packages/canonry', 'bin', 'tmp', 'input/package/bin', 'input/package/dist', 'input/package/assets/web', 'published']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'scripts/publish-canonry-npm.mjs'), script)
  const manifest = {
    name: primary,
    version,
    files: ['bin/', 'dist/', 'assets/', 'package.json', 'README.md'],
    bin: { canonry: './bin/canonry.mjs', cnry: './bin/canonry.mjs' },
    scripts: { prepublishOnly: 'exit 99', prepack: 'exit 99', prepare: 'exit 99', postpack: 'exit 99', publish: 'exit 99', postpublish: 'exit 99' },
  }
  const manifestText = `${JSON.stringify(manifest, null, 4)}\n`
  const manifestPath = path.join(root, 'packages/canonry/package.json')
  fs.writeFileSync(manifestPath, manifestText)
  fs.writeFileSync(path.join(root, 'input/package/package.json'), JSON.stringify({ ...manifest, ...artifactManifest }))
  fs.writeFileSync(path.join(root, 'input/package/dist/index.js'), 'export const builtInCI = true\n')
  fs.writeFileSync(path.join(root, 'input/package/dist/payload.bin'), Buffer.from([0, 1, 2, 255]))
  fs.writeFileSync(path.join(root, 'input/package/bin/canonry.mjs'), '#!/usr/bin/env node\nconsole.log("built in CI")\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'input/package/assets/web/index.html'), '<main>Built in CI</main>\n')
  fs.writeFileSync(path.join(root, 'input/package/README.md'), 'The exact tested package.\n')
  const tarball = path.join(root, 'tested.tgz')
  execFileSync('tar', ['-czf', tarball, '-C', path.join(root, 'input'), 'package'])

  const fake = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const command = path.basename(process.argv[1])
const root = process.env.PUBLISH_TEST_ROOT
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ command, args, cwd: process.cwd() }) + '\\n')
if (args[0] === 'view') {
  if (process.env.PUBLISH_TEST_REGISTRY_ERROR) {
    console.error('E503 registry unavailable')
    process.exit(1)
  }
  if (process.env.PUBLISH_TEST_BAD_RESPONSE) {
    console.log('unexpected registry response')
    process.exit(0)
  }
  const name = args[1].slice(0, args[1].lastIndexOf('@'))
  if ((process.env.PUBLISH_TEST_EXISTING || '').split(',').includes(name)) {
    console.log('${version}')
    process.exit(0)
  }
  console.error('E404 package not found')
  process.exit(1)
}
if (args[0] === 'publish') {
  const output = fs.mkdtempSync(path.join(root, 'published/release-'))
  if (command === 'npm') {
    if (!args.includes('--ignore-scripts')) process.exit(99)
    fs.copyFileSync(args[1], path.join(output, 'published.tgz'))
    execFileSync('tar', ['-xzf', args[1], '-C', output])
  } else {
    fs.mkdirSync(path.join(output, 'package'))
    fs.copyFileSync(path.join(root, 'packages/canonry/package.json'), path.join(output, 'package/package.json'))
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'package/package.json'), 'utf8'))
  if (process.env.PUBLISH_TEST_FAIL_NAME === manifest.name) process.exit(42)
  if (process.env.PUBLISH_TEST_REAL_DRY_RUN === '1') {
    if (command !== 'npm' || !args.includes('--dry-run')) process.exit(99)
    const result = spawnSync(process.env.PUBLISH_TEST_REAL_NPM, [...args, '--offline'], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
  process.exit(0)
}
process.exit(98)
`
  for (const command of ['npm', 'pnpm']) fs.writeFileSync(path.join(root, 'bin', command), fake, { mode: 0o755 })

  const run = (extraEnv: Record<string, string | undefined> = {}) => spawnSync(process.execPath, ['scripts/publish-canonry-npm.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
      TMPDIR: path.join(root, 'tmp'),
      NODE_DISABLE_COMPILE_CACHE: '1',
      npm_config_cache: path.join(root, 'npm-cache'),
      PUBLISH_TEST_ROOT: root,
      PUBLISH_TEST_REAL_NPM: realNpm,
      PUBLISH_TEST_REAL_DRY_RUN: undefined,
      CANONRY_NPM_PUBLISH_DRY_RUN: undefined,
      CANONRY_NPM_PUBLISH_TARBALL: tarball,
      ...extraEnv,
    },
  })
  const calls = (): Invocation[] => fs.existsSync(path.join(root, 'calls.jsonl'))
    ? fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Invocation)
    : []
  const releases = () => fs.readdirSync(path.join(root, 'published')).map(dir => {
    const output = path.join(root, 'published', dir)
    return { output, manifest: JSON.parse(fs.readFileSync(path.join(output, 'package/package.json'), 'utf8')) as typeof manifest }
  })
  const expectClean = () => {
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestText)
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  }
  return { root, tarball, run, calls, releases, expectClean }
}

test('publishes the exact tested tarball and changes only the compatibility manifest name without builds', () => {
  const f = fixture()
  const originalBytes = fs.readFileSync(f.tarball)
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  const releases = f.releases()
  expect(releases.map(release => release.manifest.name).sort()).toEqual([compatibility, primary].sort())
  const primaryRelease = releases.find(release => release.manifest.name === primary)!
  const compatibilityRelease = releases.find(release => release.manifest.name === compatibility)!
  expect(fs.readFileSync(path.join(primaryRelease.output, 'published.tgz'))).toEqual(originalBytes)
  expect(fs.readFileSync(f.tarball)).toEqual(originalBytes)
  expect(compatibilityRelease.manifest).toEqual({ ...primaryRelease.manifest, name: compatibility })
  const files = ['bin/canonry.mjs', 'dist/index.js', 'dist/payload.bin', 'assets/web/index.html', 'README.md']
  for (const file of files) {
    expect(fs.readFileSync(path.join(compatibilityRelease.output, 'package', file)))
      .toEqual(fs.readFileSync(path.join(primaryRelease.output, 'package', file)))
  }
  for (const release of releases) expect(fs.statSync(path.join(release.output, 'package/bin/canonry.mjs')).mode & 0o777).toBe(0o755)
  expect(execFileSync('tar', ['-tzf', path.join(compatibilityRelease.output, 'published.tgz')], { encoding: 'utf8' }).trim().split('\n').sort())
    .toEqual(execFileSync('tar', ['-tzf', f.tarball], { encoding: 'utf8' }).trim().split('\n').sort())
  expect(f.calls().map(call => `${call.command} ${call.args[0]}`)).toEqual(['npm view', 'npm view', 'npm publish', 'npm publish'])
  for (const call of f.calls().filter(call => call.args[0] !== 'view')) expect(call.args).toContain('--ignore-scripts')
  f.expectClean()
})

test.each([{ name: compatibility }, { version: '9.9.9' }])('refuses an artifact with a mismatched manifest: %j', manifest => {
  const f = fixture(manifest)
  const result = f.run()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(`Publish tarball must contain ${primary}@${version}`)
  expect(f.releases()).toEqual([])
  f.expectClean()
})

test.each(['relative.tgz', ''])('refuses an invalid artifact path: %s', tarball => {
  const f = fixture()
  const result = f.run({ CANONRY_NPM_PUBLISH_TARBALL: tarball })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('must be an absolute path')
  expect(f.releases()).toEqual([])
  f.expectClean()
})

test('refuses a corrupt tarball before publishing', () => {
  const f = fixture()
  fs.writeFileSync(f.tarball, 'invalid tarball')
  expect(f.run().status).not.toBe(0)
  expect(f.releases()).toEqual([])
  f.expectClean()
})

test('refuses archive links before extraction', () => {
  const f = fixture()
  fs.symlinkSync('../../outside', path.join(f.root, 'input/package/link'))
  execFileSync('tar', ['-czf', f.tarball, '-C', path.join(f.root, 'input'), 'package'])
  const result = f.run()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('only regular files and directories')
  expect(f.releases()).toEqual([])
  f.expectClean()
})

test('refuses archive entries outside package/', () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.root, 'input/outside'), 'unexpected entry')
  execFileSync('tar', ['-czf', f.tarball, '-C', path.join(f.root, 'input'), 'package', 'outside'])
  const result = f.run()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('only package/ entries')
  expect(f.releases()).toEqual([])
  f.expectClean()
})

test.each([primary, compatibility, `${primary},${compatibility}`])('skips already published packages: %s', existing => {
  const f = fixture()
  const result = f.run({ PUBLISH_TEST_EXISTING: existing })
  expect(result.status, result.stderr).toBe(0)
  expect(f.releases().map(release => release.manifest.name)).toEqual([primary, compatibility].filter(name => !existing.split(',').includes(name)))
  expect(f.calls().filter(call => call.args[0] === 'publish')).toHaveLength(existing.split(',').length === 2 ? 0 : 1)
  f.expectClean()
})

test.each(['PUBLISH_TEST_REGISTRY_ERROR', 'PUBLISH_TEST_BAD_RESPONSE'])('fails closed on a bad registry response: %s', variable => {
  const f = fixture()
  const result = f.run({ [variable]: '1' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Unable to check')
  expect(f.calls()).toHaveLength(1)
  expect(f.releases()).toEqual([])
  f.expectClean()
})

test.each([primary, compatibility])('cleans temporary files after publication fails for %s', name => {
  const f = fixture()
  expect(f.run({ PUBLISH_TEST_FAIL_NAME: name }).status).not.toBe(0)
  expect(f.releases()).toHaveLength(name === primary ? 1 : 2)
  f.expectClean()
})

test.each([true, false])('dry run forwards the flag and bypasses registry queries (artifact mode: %s)', artifact => {
  const f = fixture()
  const result = f.run({ CANONRY_NPM_PUBLISH_DRY_RUN: '1', CANONRY_NPM_PUBLISH_TARBALL: artifact ? f.tarball : undefined })
  expect(result.status, result.stderr).toBe(0)
  expect(f.calls().filter(call => call.args[0] === 'view')).toEqual([])
  const publishes = f.calls().filter(call => call.args[0] === 'publish')
  expect(publishes).toHaveLength(2)
  for (const call of publishes) expect(call.args).toContain('--dry-run')
  f.expectClean()
})

test('real npm publishes both tarballs in offline dry-run mode without running lifecycle scripts', () => {
  const f = fixture()
  const result = f.run({ CANONRY_NPM_PUBLISH_DRY_RUN: '1', PUBLISH_TEST_REAL_DRY_RUN: '1' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain(`+ ${primary}@${version}`)
  expect(result.stdout).toContain(`+ ${compatibility}@${version}`)
  expect(f.releases()).toHaveLength(2)
  expect(f.calls().map(call => `${call.command} ${call.args[0]}`)).toEqual(['npm publish', 'npm publish'])
  f.expectClean()
})

test.each([undefined, primary, compatibility])('local publication preserves lifecycle behavior and restores the manifest on failure: %s', failure => {
  const f = fixture()
  const result = f.run({ CANONRY_NPM_PUBLISH_TARBALL: undefined, PUBLISH_TEST_FAIL_NAME: failure })
  expect(result.status === 0).toBe(failure === undefined)
  const publishes = f.calls().filter(call => call.args[0] === 'publish')
  expect(publishes).toHaveLength(failure === primary ? 1 : 2)
  for (const call of publishes) {
    expect(call.command).toBe('pnpm')
    expect(call.args).toEqual(['publish', 'packages/canonry', '--no-git-checks', '--access', 'public'])
  }
  f.expectClean()
})
