import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import Database from 'better-sqlite3'
import { errors } from 'oidc-provider'

interface StoredRow {
  id_hash: string
  payload: Buffer
  expires_at: number | null
}

interface OidcPayload {
  grantId?: string
  uid?: string
  userCode?: string
  consumed?: number
  [key: string]: unknown
}

/** Gateway-only database. It contains no Canonry business data or password database. */
export class GatewayStore {
  private readonly db: Database.Database
  private readonly key: Buffer

  constructor(path: string, key: Buffer) {
    if (key.length !== 32) throw new Error('Gateway vault key must contain exactly 32 bytes')
    this.key = Buffer.from(key)
    this.db = new Database(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_metadata (
        name TEXT PRIMARY KEY,
        payload BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_records (
        kind TEXT NOT NULL,
        id_hash TEXT NOT NULL,
        payload BLOB NOT NULL,
        expires_at INTEGER,
        grant_hash TEXT,
        uid_hash TEXT,
        user_code_hash TEXT,
        PRIMARY KEY (kind, id_hash)
      );
      CREATE INDEX IF NOT EXISTS gateway_records_grant ON gateway_records (grant_hash);
      CREATE INDEX IF NOT EXISTS gateway_records_uid ON gateway_records (kind, uid_hash);
      CREATE INDEX IF NOT EXISTS gateway_records_user_code ON gateway_records (kind, user_code_hash);
      CREATE INDEX IF NOT EXISTS gateway_records_expiry ON gateway_records (expires_at);
      CREATE TABLE IF NOT EXISTS gateway_leases (
        kind TEXT NOT NULL,
        id_hash TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id_hash)
      );
    `)
    try {
      this.db.transaction(() => {
        const check = this.db.prepare("SELECT payload FROM gateway_metadata WHERE name = 'key-check'")
          .get() as { payload: Buffer } | undefined
        if (check) {
          this.open('metadata', { id_hash: 'key-check', payload: check.payload, expires_at: null })
        } else {
          this.db.prepare("INSERT INTO gateway_metadata (name, payload) VALUES ('key-check', ?)")
            .run(this.seal('metadata', 'key-check', { id: 'key-check', value: 1 }))
        }
      }).immediate()
    } catch (error) {
      this.close()
      throw error
    }
  }

  private hash(purpose: string, value: string): string {
    return createHmac('sha256', this.key).update(JSON.stringify([purpose, value])).digest('hex')
  }

  private seal(kind: string, idHash: string, value: unknown): Buffer {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(JSON.stringify([kind, idHash])))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
  }

  private open<T>(kind: string, row: StoredRow): { id: string; value: T } {
    try {
      if (row.payload[0] !== 1 || row.payload.length < 30) throw new Error('Invalid envelope')
      const decipher = createDecipheriv('aes-256-gcm', this.key, row.payload.subarray(1, 13))
      decipher.setAAD(Buffer.from(JSON.stringify([kind, row.id_hash])))
      decipher.setAuthTag(row.payload.subarray(13, 29))
      const plaintext = Buffer.concat([decipher.update(row.payload.subarray(29)), decipher.final()])
      return JSON.parse(plaintext.toString('utf8')) as { id: string; value: T }
    } catch {
      throw new Error('Gateway credential store could not decrypt a record')
    }
  }

  private row(kind: string, id: string): StoredRow | undefined {
    return this.db.prepare(`SELECT id_hash, payload, expires_at FROM gateway_records
      WHERE kind = ? AND id_hash = ? AND (expires_at IS NULL OR expires_at > ?)`)
      .get(kind, this.hash('id', id), Date.now()) as StoredRow | undefined
  }

  get<T>(kind: string, id: string): T | undefined {
    const row = this.row(kind, id)
    return row ? this.open<T>(kind, row).value : undefined
  }

  put(kind: string, id: string, value: unknown, ttlSeconds?: number): void {
    if (ttlSeconds !== undefined && (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)) {
      throw new Error('Gateway record lifetime must be a nonnegative finite number')
    }
    const idHash = this.hash('id', id)
    const payload = this.seal(kind, idHash, { id, value })
    const metadata = value && typeof value === 'object' ? value as OidcPayload : {}
    const index = (field: 'grantId' | 'uid' | 'userCode') => typeof metadata[field] === 'string'
      ? this.hash(field, metadata[field]) : null
    this.db.prepare(`INSERT INTO gateway_records (kind, id_hash, payload, expires_at, grant_hash, uid_hash, user_code_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, id_hash) DO UPDATE SET
      payload = excluded.payload, expires_at = excluded.expires_at, grant_hash = excluded.grant_hash,
      uid_hash = excluded.uid_hash, user_code_hash = excluded.user_code_hash`)
      .run(kind, idHash, payload, ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
        index('grantId'), index('uid'), index('userCode'))
  }

  delete(kind: string, id: string): void {
    this.db.prepare('DELETE FROM gateway_records WHERE kind = ? AND id_hash = ?').run(kind, this.hash('id', id))
  }

  /** State/PKCE transactions disappear before returning, including across processes. */
  take<T>(kind: string, id: string): T | undefined {
    return this.db.transaction(() => {
      const value = this.get<T>(kind, id)
      this.delete(kind, id)
      return value
    }).immediate()
  }

  list<T>(kind: string): Array<{ id: string; value: T }> {
    const rows = this.db.prepare(`SELECT id_hash, payload, expires_at FROM gateway_records
      WHERE kind = ? AND (expires_at IS NULL OR expires_at > ?)`)
      .all(kind, Date.now()) as StoredRow[]
    return rows.map(row => this.open<T>(kind, row))
  }

  /** A bounded cross-process lease; callers must finish remote work before expiry. */
  acquireLease(kind: string, id: string, ttlSeconds: number): string | undefined {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('Lease lifetime must be positive')
    const owner = randomUUID()
    const now = Date.now()
    const result = this.db.prepare(`INSERT INTO gateway_leases (kind, id_hash, owner, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (kind, id_hash) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE gateway_leases.expires_at <= ?`).run(kind, this.hash('id', id), owner, now + ttlSeconds * 1000, now)
    return result.changes === 1 ? owner : undefined
  }

  releaseLease(kind: string, id: string, owner: string): void {
    this.db.prepare('DELETE FROM gateway_leases WHERE kind = ? AND id_hash = ? AND owner = ?')
      .run(kind, this.hash('id', id), owner)
  }

  pruneExpired(): void {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM gateway_records WHERE expires_at <= ?').run(now)
      this.db.prepare('DELETE FROM gateway_leases WHERE expires_at <= ?').run(now)
    }).immediate()
  }

  oidcAdapter() {
    const store = {
      db: this.db,
      get: this.get.bind(this),
      put: this.put.bind(this),
      delete: this.delete.bind(this),
      hash: this.hash.bind(this),
      row: this.row.bind(this),
      open: this.open.bind(this),
      seal: this.seal.bind(this),
    }
    return class GatewayOidcAdapter {
      private readonly kind: string

      constructor(name: string) { this.kind = `oidc:${name}` }

      upsert(id: string, payload: OidcPayload, expiresIn?: number): Promise<void> {
        store.db.transaction(() => {
          if (this.kind === 'oidc:ReplayDetection' && store.get(this.kind, id)) {
            throw new errors.InvalidGrant('Replay detected')
          }
          store.put(this.kind, id, payload, expiresIn)
        }).immediate()
        return Promise.resolve()
      }

      find(id: string): Promise<OidcPayload | undefined> {
        return Promise.resolve(store.get<OidcPayload>(this.kind, id))
      }

      private findBy(field: 'uid' | 'userCode', value: string): OidcPayload | undefined {
        const column = field === 'uid' ? 'uid_hash' : 'user_code_hash'
        const row = store.db.prepare(`SELECT id_hash, payload, expires_at FROM gateway_records
          WHERE kind = ? AND ${column} = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`)
          .get(this.kind, store.hash(field, value), Date.now()) as StoredRow | undefined
        return row ? store.open<OidcPayload>(this.kind, row).value : undefined
      }

      findByUid(uid: string): Promise<OidcPayload | undefined> { return Promise.resolve(this.findBy('uid', uid)) }
      findByUserCode(code: string): Promise<OidcPayload | undefined> { return Promise.resolve(this.findBy('userCode', code)) }

      consume(id: string): Promise<void> {
        const accepted = store.db.transaction(() => {
          const row = store.row(this.kind, id)
          if (!row) return false
          const envelope = store.open<OidcPayload>(this.kind, row)
          if (envelope.value.consumed) {
            if (envelope.value.grantId) {
              store.db.prepare("DELETE FROM gateway_records WHERE grant_hash = ? AND kind LIKE 'oidc:%'")
                .run(store.hash('grantId', envelope.value.grantId))
              store.delete('oidc:Grant', envelope.value.grantId)
            }
            return false
          }
          envelope.value.consumed = Math.floor(Date.now() / 1000)
          store.db.prepare('UPDATE gateway_records SET payload = ? WHERE kind = ? AND id_hash = ?')
            .run(store.seal(this.kind, row.id_hash, envelope), this.kind, row.id_hash)
          return true
        }).immediate()
        if (!accepted) throw new errors.InvalidGrant('Authorization has already been consumed or expired')
        return Promise.resolve()
      }

      destroy(id: string): Promise<void> {
        store.delete(this.kind, id)
        return Promise.resolve()
      }

      revokeByGrantId(grantId: string): Promise<void> {
        store.db.prepare("DELETE FROM gateway_records WHERE grant_hash = ? AND kind LIKE 'oidc:%'").run(store.hash('grantId', grantId))
        return Promise.resolve()
      }
    }
  }

  close(): void {
    this.db.close()
    this.key.fill(0)
  }
}
