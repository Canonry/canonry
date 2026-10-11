import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const cliPath = path.join(repoRoot, 'packages/canonry/dist/cli.js')

function ensureBuiltCli(): void {
  if (!existsSync(cliPath)) {
    execFileSync('pnpm', ['--filter', '@canonry/canonry', 'build:cli'], { cwd: repoRoot, stdio: 'pipe' })
  }
}

function runBuiltCli(args: string[], configDir: string, port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  ensureBuiltCli()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, CANONRY_CONFIG_DIR: configDir, CANONRY_BASE_URL: `http://127.0.0.1:${port}`, CANONRY_STORED_ONLY: '', CANONRY_TELEMETRY: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('built CLI stored-only boundary', () => {
  it('refuses a write before config, telemetry, autosync, or HTTP access', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'canonry-stored-only-cli-'))
    const configPath = path.join(configDir, 'config.yaml')
    writeFileSync(configPath, JSON.stringify({ apiUrl: 'http://127.0.0.1:9', database: path.join(configDir, 'data.db'), apiKey: 'test-key' }))
    let configBefore = ''
    let requests = 0
    const trap = createServer((_request, response) => {
      requests += 1
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([]))
    })
    await new Promise<void>(resolve => trap.listen(0, '127.0.0.1', resolve))
    const address = trap.address()
    if (!address || typeof address === 'string') throw new Error('trap did not bind')
    writeFileSync(configPath, JSON.stringify({ apiUrl: `http://127.0.0.1:${address.port}`, database: path.join(configDir, 'data.db'), apiKey: 'test-key' }))
    configBefore = readFileSync(configPath, 'utf8')
    try {
      const refused = await runBuiltCli(['--stored-only', '--format', 'json', 'project', 'update', 'acme'], configDir, address.port)
      expect(refused.code).toBe(1)
      expect(refused.stderr + refused.stdout).toContain('STORED_ONLY_REFUSED')
      expect(requests).toBe(0)
      expect(readdirSync(configDir)).toEqual(['config.yaml'])

      const allowed = await runBuiltCli(['--stored-only', 'project', 'list', '--format', 'json'], configDir, address.port)
      expect(allowed.code).toBe(0)
      expect(allowed.stderr + allowed.stdout).not.toContain('Update available')
      expect(requests).toBe(2)
      expect(readdirSync(configDir)).toEqual(['config.yaml'])
      expect(readFileSync(configPath, 'utf8')).toBe(configBefore)

      const help = await runBuiltCli(['--stored-only', '--help'], configDir, address.port)
      expect(help.code).toBe(0)
      expect(help.stdout + help.stderr).toContain('Usage:')
      expect(requests).toBe(2)
    } finally {
      await new Promise<void>(resolve => trap.close(() => resolve()))
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 30_000)
})
