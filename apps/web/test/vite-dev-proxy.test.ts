// @vitest-environment node

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createServer, type ViteDevServer } from 'vite'
import { afterEach, describe, expect, test, vi } from 'vitest'

// `pnpm dev:web` listens on every interface and forwards API calls to
// `canonry serve` over loopback. Canonry lets a request with a loopback peer,
// a loopback Host, and no forwarding header set the first dashboard password
// without the root API key. Vite rewrites Host to the target, so without
// X-Forwarded-For a LAN visitor's call through the dev server looks local.
describe('Vite dev proxy', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    vi.unstubAllEnvs()
  })

  async function listen(server: http.Server) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    return (server.address() as AddressInfo).port
  }

  test.each(['/api/v1/session', '/health'])('marks %s as forwarded when it reaches canonry serve', async (route) => {
    const received: http.IncomingHttpHeaders[] = []
    const upstreamPort = await listen(http.createServer((request, response) => {
      received.push(request.headers)
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    }))
    vi.stubEnv('CANONRY_API_URL', `http://127.0.0.1:${upstreamPort}`)
    vi.resetModules()
    const { default: viteConfig } = await import('../vite.config.js')

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-vite-proxy-'))
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const dev: ViteDevServer = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { host: '127.0.0.1', port: 0, strictPort: true, ws: false, watch: null, proxy: viteConfig.server?.proxy },
    })
    cleanups.push(() => dev.close())
    await dev.listen()
    const devPort = (dev.httpServer!.address() as AddressInfo).port

    const response = await fetch(`http://127.0.0.1:${devPort}${route}`)
    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      host: `127.0.0.1:${upstreamPort}`,
      'x-forwarded-for': '127.0.0.1',
    })
  })
})
