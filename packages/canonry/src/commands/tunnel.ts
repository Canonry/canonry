import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

/**
 * Spawns a cloudflared quicktunnel to the given target URL and returns
 * the assigned public URL. Cleans up the tunnel process on exit.
 */
export async function openCloudflaredTunnel(targetUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tunnelLog = createWriteStream('/tmp/canonry-tunnel.log')

    const proc = spawn('cloudflared', ['tunnel', '--url', targetUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let resolved = false

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      if (!proc.killed) {
        proc.kill('SIGTERM')
      }
      try {
        tunnelLog.end()
      } catch {
        // already closed
      }
    }

    process.on('exit', cleanup)

    // cloudflared writes the tunnel URL to stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (resolved) return
      const line = chunk.toString()
      try {
        tunnelLog.write(line)
      } catch {
        // stream closed
      }
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (match) {
        resolved = true
        // Don't kill cloudflared — keep the tunnel alive for the webhook
        resolve(match[0])
      }
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      try {
        tunnelLog.write(chunk.toString())
      } catch {
        // stream closed
      }
    })

    proc.on('error', (err) => {
      tunnelLog.end()
      if (!resolved) {
        resolved = true
        reject(new Error(`Failed to spawn cloudflared: ${err.message}`))
      }
    })

    proc.on('exit', (code) => {
      tunnelLog.end()
      if (!resolved && code !== null && code !== 0) {
        resolved = true
        reject(new Error(`cloudflared exited with code ${code}`))
      }
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        cleanup()
        reject(new Error('cloudflared tunnel timed out after 30s'))
      }
    }, 30_000)
  })
}
