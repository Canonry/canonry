import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { onTestFinished } from 'vitest'

/**
 * A loopback OpenAI-compatible runtime that answers every request with
 * `content`, for driving the real Local adapter. Returns its base URL.
 */
export async function startLocalRuntime(content: string): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1758700000,
        model: 'llama3:8b',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}
