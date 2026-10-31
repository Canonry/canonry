import { setTimeout } from 'node:timers/promises'

import Fastify from 'fastify'
import { createClient } from '@canonry/canonry-db'
import { describeError } from '@canonry/canonry-contracts'

import { registerOAuthRoutes } from '../../src/oauth.js'
import { createCredentialChecker } from '../../src/user-session.js'

// Each child owns a real SQLite connection and the production token endpoint.
// IPC coordinates arrival only; no lock or token operation is mocked.
const databasePath = process.argv[2]
if (!databasePath) throw new Error('OAuth worker requires a synthetic database path')
const db = createClient(databasePath)
const app = Fastify()
registerOAuthRoutes(app, {
  db, issuer: 'https://instance.example.com', resourcePaths: ['/api/v1/mcp'],
  resolveUser: () => null,
  startSession: () => { throw new Error('Concurrency worker never signs in') },
  credentials: createCredentialChecker({ db }),
})
await app.ready()
process.on('message', (message: { id: number; refreshToken: string; startAt: number }) => {
  void (async () => {
    await setTimeout(Math.max(0, message.startAt - Date.now()))
    const response = await app.inject({ method: 'POST', url: '/oauth/token', payload: {
      grant_type: 'refresh_token', refresh_token: message.refreshToken, client_id: 'client-1',
    } })
    process.send?.({ id: message.id, status: response.statusCode, body: response.json() })
  })().catch(error => {
    process.send?.({ id: message.id, failure: describeError(error) })
  })
})
process.once('disconnect', () => {
  void app.close().finally(() => { db.$client.close(); process.exit(0) })
})
process.send?.({ ready: true })
