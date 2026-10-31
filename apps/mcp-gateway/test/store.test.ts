import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayStore } from '../src/store.js'

const directories: string[] = []
const stores: GatewayStore[] = []
function openStore(path: string, key: Buffer): GatewayStore {
  const store = new GatewayStore(path, key)
  stores.push(store)
  return store
}
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'canonry-gateway-vault-'))
  directories.push(directory)
  return join(directory, 'gateway.sqlite')
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('gateway credential vault', () => {
  it('persists encrypted credentials across restart and fails closed with another vault key', () => {
    const path = databasePath()
    const key = randomBytes(32)
    const secretId = 'oauth-secret-bearer-id'
    const secret = { refreshToken: 'upstream-refresh-secret', userId: 'tenant-local-user' }
    const first = new GatewayStore(path, key)
    first.put('upstream', secretId, secret)
    first.close()
    const bytes = readFileSync(path)
    for (const value of [secretId, ...Object.values(secret)]) expect(bytes.includes(Buffer.from(value))).toBe(false)
    expect(openStore(path, key).get('upstream', secretId)).toEqual(secret)
    expect(() => new GatewayStore(path, randomBytes(32))).toThrow('could not decrypt')
  })

  it('cannot transplant encrypted credentials between two records', () => {
    const path = databasePath()
    const store = openStore(path, randomBytes(32))
    store.put('upstream', 'tenant-one', { accessToken: 'one' })
    store.put('upstream', 'tenant-two', { accessToken: 'two' })
    const raw = new Database(path)
    try {
      const rows = raw.prepare("SELECT id_hash, payload FROM gateway_records WHERE kind = 'upstream' ORDER BY id_hash").all() as Array<{ id_hash: string; payload: Buffer }>
      raw.prepare("UPDATE gateway_records SET payload = ? WHERE kind = 'upstream' AND id_hash = ?").run(rows[0]!.payload, rows[1]!.id_hash)
    } finally { raw.close() }
    expect(() => store.list('upstream')).toThrow('could not decrypt')
  })

  it('consumes browser state once and coordinates refresh ownership across database connections', () => {
    const path = databasePath()
    const key = randomBytes(32)
    const first = openStore(path, key)
    const second = openStore(path, key)
    first.put('authorization', 'state', { verifier: 'proof', tenant: 'one' }, 60)
    expect(second.take('authorization', 'state')).toEqual({ verifier: 'proof', tenant: 'one' })
    expect(first.take('authorization', 'state')).toBeUndefined()
    const lease = first.acquireLease('refresh', 'grant', 30)
    expect(typeof lease).toBe('string')
    expect(second.acquireLease('refresh', 'grant', 30)).toBeUndefined()
    second.releaseLease('refresh', 'grant', 'not-the-owner')
    expect(second.acquireLease('refresh', 'grant', 30)).toBeUndefined()
    first.releaseLease('refresh', 'grant', lease!)
    expect(second.acquireLease('refresh', 'grant', 30)).toBeTypeOf('string')
  })

  it('marks OIDC tokens consumed without extending expiry and revokes only the replayed grant', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const store = openStore(databasePath(), randomBytes(32))
    const Adapter = store.oidcAdapter()
    const refresh = new Adapter('RefreshToken')
    const access = new Adapter('AccessToken')
    const grant = new Adapter('Grant')
    await grant.upsert('grant-a', { accountId: 'alice' }, 100)
    await refresh.upsert('refresh-a', { grantId: 'grant-a' }, 10)
    await access.upsert('access-a', { grantId: 'grant-a' }, 100)
    await access.upsert('access-b', { grantId: 'grant-b' }, 100)
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'))
    await refresh.consume('refresh-a')
    expect(await refresh.find('refresh-a')).toEqual({ grantId: 'grant-a', consumed: 1767225605 })
    await expect(Promise.resolve().then(() => refresh.consume('refresh-a'))).rejects.toMatchObject({ error: 'invalid_grant' })
    expect(await access.find('access-a')).toBeUndefined()
    expect(await grant.find('grant-a')).toBeUndefined()
    expect(await access.find('access-b')).toEqual({ grantId: 'grant-b' })
    await refresh.upsert('expires', { grantId: 'other' }, 10)
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'))
    await refresh.consume('expires')
    vi.setSystemTime(new Date('2026-01-01T00:00:15Z'))
    expect(await refresh.find('expires')).toBeUndefined()
  })

  it('preserves session indexes and blocks replay-detection replacement', async () => {
    const store = openStore(databasePath(), randomBytes(32))
    const Adapter = store.oidcAdapter()
    const sessions = new Adapter('Session')
    await sessions.upsert('session', { uid: 'stable-uid', userCode: 'short-code' }, 60)
    expect(await sessions.findByUid('stable-uid')).toEqual({ uid: 'stable-uid', userCode: 'short-code' })
    expect(await sessions.findByUserCode('short-code')).toEqual({ uid: 'stable-uid', userCode: 'short-code' })
    await sessions.destroy('session')
    expect(await sessions.findByUid('stable-uid')).toBeUndefined()
    const replays = new Adapter('ReplayDetection')
    await replays.upsert('nonce', { accountId: 'first' }, 60)
    await expect(Promise.resolve().then(() => replays.upsert('nonce', { accountId: 'second' }, 60))).rejects.toMatchObject({ error: 'invalid_grant' })
    expect(await replays.find('nonce')).toEqual({ accountId: 'first' })
  })
})
