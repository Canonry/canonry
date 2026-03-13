import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
