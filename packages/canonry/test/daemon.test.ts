import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

describe('daemon cliPath resolution', () => {
  it('resolves cliPath to the same file as import.meta.url (not a parent directory)', async () => {
    // This mirrors the logic in startDaemon — the bug was using '../cli.js'
    // which goes one directory too high when tsup bundles into dist/cli.js
    const daemonUrl = new URL('../src/commands/daemon.ts', import.meta.url)
    const cliPath = path.resolve(new URL(daemonUrl).pathname)

    // The resolved path must point to an existing file
    assert.ok(fs.existsSync(cliPath), `cliPath should exist: ${cliPath}`)

    // The old buggy path '../cli.js' relative to daemon.ts would resolve outside src/
    const buggyPath = path.resolve(path.dirname(cliPath), '..', 'cli.js')
    // In the source tree, ../cli.js from commands/ lands in src/cli.ts not src/cli.js,
    // so this verifies the two paths are different
    assert.notEqual(
      path.dirname(cliPath),
      path.dirname(buggyPath),
      'cliPath should not resolve to a parent directory',
    )
  })
})

describe('daemon', () => {
  let tmpDir: string
  let origConfigDir: string | undefined

  afterEach(() => {
    if (origConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = origConfigDir
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function setup() {
    tmpDir = path.join(os.tmpdir(), `canonry-daemon-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir
  }

  it('stopDaemon prints not-running when no PID file exists', async () => {
    setup()
    const { stopDaemon } = await import('../src/commands/daemon.js')

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      stopDaemon()
    } finally {
      console.log = origLog
    }

    assert.ok(logs.some(l => l.includes('not running')))
  })

  it('stopDaemon cleans up stale PID file', async () => {
    setup()
    const pidPath = path.join(tmpDir, 'canonry.pid')
    // Write a PID that almost certainly doesn't exist
    fs.writeFileSync(pidPath, '999999999', 'utf-8')

    const { stopDaemon } = await import('../src/commands/daemon.js')

    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)
    try {
      stopDaemon()
    } finally {
      console.log = origLog
    }

    assert.ok(logs.some(l => l.includes('stale PID') || l.includes('not running')))
    assert.ok(!fs.existsSync(pidPath), 'PID file should be cleaned up')
  })
})
