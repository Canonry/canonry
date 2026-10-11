import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function runBuiltCli(args: string[], configDir: string, port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('packages/canonry/dist/cli.js'), ...args], {
      cwd: path.resolve('.'),
      env: { ...process.env, CANONRY_CONFIG_DIR: configDir, CANONRY_BASE_URL: `http://127.0.0.1:${port}`, CANONRY_STORED_ONLY: '' },
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
    let requests = 0
    const trap = createServer((_request, response) => {
      requests += 1
      response.statusCode = 500
      response.end('unexpected request')
    })
    await new Promise<void>(resolve => trap.listen(0, '127.0.0.1', resolve))
    const address = trap.address()
    if (!address || typeof address === 'string') throw new Error('trap did not bind')
    try {
      const refused = await runBuiltCli(['--stored-only', '--format', 'json', 'project', 'update', 'acme'], configDir, address.port)
      expect(refused.code).toBe(1)
      expect(refused.stderr + refused.stdout).toContain('STORED_ONLY_REFUSED')
      expect(requests).toBe(0)
      expect(readdirSync(configDir)).toEqual([])

      const help = await runBuiltCli(['--stored-only', '--help'], configDir, address.port)
      expect(help.code).toBe(0)
      expect(help.stdout + help.stderr).toContain('Usage:')
      expect(requests).toBe(0)
    } finally {
      await new Promise<void>(resolve => trap.close(() => resolve()))
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 30_000)
})
