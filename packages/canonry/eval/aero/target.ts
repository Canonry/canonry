/**
 * Serve a COPY of a Canonry database in-process, for the Aero eval.
 *
 * The server is this worktree's own `createServer`, bound to 127.0.0.1 on a
 * free port with no background work: it is started with a raw
 * `app.server.listen`, so Fastify's `onListen` hook (scheduler, site-liveness
 * loop, research re-dispatch) never runs, and Aero is prompt-only, so a run
 * completing can never wake it. A request guard sits in front of the router:
 * reads pass, the agent's own prompt and reset routes pass, and everything
 * else that would change data or call an outside service (runs, syncs, live
 * provider reads) is refused with a 403 the model can read.
 *
 * Three independent checks refuse a database that looks live: the path a
 * running pm2 process (or any `~/.canonry*` config) uses, a path under
 * `~/.canonry*` outside a temp or scratch folder, and a file another process
 * has open. The config directory is never used in place: only its
 * `config.yaml` is copied into a private temp directory (0700, file 0600) and
 * deleted on close.
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { and, eq, inArray } from 'drizzle-orm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { MEASUREMENT_PLAN_V2_SCHEMA_VERSION } from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  users,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { createUserSession, hashApiKey, USER_SESSION_COOKIE_NAME } from '@ainyc/canonry-api-routes'
import { aeroProjectShape } from '../../src/agent/project-shape.js'
import type { CanonryConfig } from '../../src/config.js'
import type { CostReader, CostSnapshot, RunnerTarget } from './runner.js'
import type { EvalLane, ProjectKind } from './types.js'

// ───────────────────────────── live-database guard ─────────────────────────────

export interface Pm2Process {
  name?: string
  pm2_env?: Record<string, unknown> & { env?: Record<string, unknown>; args?: unknown }
}

export interface LiveDatabaseDiscovery {
  /** Real paths of databases a running or configured instance uses. */
  databases: string[]
  /** Every absolute path a running pm2 process references (cwd, script, args, env values). */
  referencedPaths: string[]
  /** What could not be checked, for the operator. */
  notes: string[]
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function readConfigDatabase(configDir: string): string | null {
  const file = path.join(configDir, 'config.yaml')
  try {
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as { database?: unknown } | null
    const db = parsed?.database
    if (typeof db !== 'string' || !db.trim() || db === ':memory:') return null
    return path.isAbsolute(db) ? db : path.resolve(configDir, db)
  } catch {
    return null
  }
}

function listPm2Processes(): Pm2Process[] | null {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 256 * 1024 * 1024,
    })
    const start = out.indexOf('[')
    if (start < 0) return []
    return JSON.parse(out.slice(start)) as Pm2Process[]
  } catch {
    return null
  }
}

function looksLikeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes(':') && !value.includes('\n')
}

/**
 * Where live Canonry databases are. Reads pm2's process list (paths only; env
 * values that are not paths, secrets included, are never kept or printed) and
 * every `~/.canonry*` config.
 */
export function discoverLiveDatabases(opts: { home?: string; pm2?: () => Pm2Process[] | null } = {}): LiveDatabaseDiscovery {
  const home = opts.home ?? os.homedir()
  const databases = new Set<string>()
  const referenced = new Set<string>()
  const notes: string[] = []
  const configDirs = new Set<string>([path.join(home, '.canonry')])

  const processes = (opts.pm2 ?? listPm2Processes)()
  if (processes === null) notes.push('pm2 is not available; running pm2 processes were not checked.')
  for (const proc of processes ?? []) {
    const env = proc.pm2_env ?? {}
    const nested = (env.env && typeof env.env === 'object' ? env.env : {}) as Record<string, unknown>
    const values: unknown[] = [env.pm_cwd, env.pm_exec_path, ...(Array.isArray(env.args) ? env.args : []), ...Object.values(nested)]
    for (const [key, value] of Object.entries(env)) {
      if (key !== 'env' && typeof value === 'string') values.push(value)
    }
    for (const value of values) if (looksLikeAbsolutePath(value)) referenced.add(realpathOrSelf(value))
    const configDir = nested.CANONRY_CONFIG_DIR ?? env.CANONRY_CONFIG_DIR
    if (typeof configDir === 'string' && configDir.trim()) configDirs.add(configDir.trim())
    else {
      const procHome = nested.HOME ?? env.HOME
      if (typeof procHome === 'string' && procHome.trim()) configDirs.add(path.join(procHome.trim(), '.canonry'))
    }
  }
  try {
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith('.canonry')) configDirs.add(path.join(home, entry))
    }
  } catch {
    notes.push('Could not list the home directory for ~/.canonry* configs.')
  }
  for (const dir of configDirs) {
    const db = readConfigDatabase(dir)
    if (db) databases.add(realpathOrSelf(db))
  }
  return { databases: [...databases], referencedPaths: [...referenced], notes }
}

/** Pids (other than this one) holding the file or its WAL open. Linux only; empty elsewhere. */
export function processesHoldingFile(file: string): number[] {
  if (process.platform !== 'linux') return []
  const targets = new Set([file, `${file}-wal`])
  const pids: number[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    let fds: string[]
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (targets.has(fs.readlinkSync(`/proc/${entry}/fd/${fd}`))) {
          pids.push(Number(entry))
          break
        }
      } catch {
        // The fd closed while we looked.
      }
    }
  }
  return pids
}

const SCRATCH_SEGMENT = /^(?:tmp|temp|scratch.*|.*-scratch|.*-tmp)$/i

function isInsideDir(p: string, dir: string): boolean {
  const relative = path.relative(dir, p)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Refuse anything that could be a live database. Throws with the reason; the
 * database path is the only path the message names.
 */
export function assertSafeDatabasePath(
  dbPath: string,
  opts: {
    discovery: LiveDatabaseDiscovery
    home?: string
    /** Config dirs the eval reads; their own `database` is live by definition. */
    configDirs?: string[]
    holders?: (file: string) => number[]
  },
): string {
  if (!dbPath || dbPath === ':memory:') throw new Error('--db must be the path to a database file copy.')
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) throw new Error(`--db ${dbPath} is not a file.`)
  const real = fs.realpathSync(dbPath)
  const stat = fs.statSync(real)
  const home = opts.home ?? os.homedir()
  const refuse = (why: string): never => {
    throw new Error(`Refusing to use ${real}: ${why} The eval only runs on a copy, for example: sqlite3 -readonly <live.db> "VACUUM INTO '/tmp/aero-eval/copy.db'"`)
  }

  const live = new Set(opts.discovery.databases)
  // The source config's own database is live, except for a scratch copy of a
  // whole config dir: a config in a temp or scratch folder whose database sits
  // inside that same dir. A server running on it is still caught by the pm2
  // and open-file checks below.
  const inScratch = (dir: string) => isInsideDir(dir, realpathOrSelf(os.tmpdir())) || dir.split(path.sep).some(segment => SCRATCH_SEGMENT.test(segment))
  for (const dir of opts.configDirs ?? []) {
    const db = readConfigDatabase(dir)
    if (!db) continue
    const configured = realpathOrSelf(db)
    const configDir = realpathOrSelf(dir)
    if (configured === real && isInsideDir(real, configDir) && inScratch(configDir)) continue
    live.add(configured)
  }
  for (const candidate of live) {
    if (candidate === real) refuse('it is the database a Canonry config points at.')
    let other: fs.Stats | undefined
    try {
      other = fs.statSync(candidate)
    } catch {
      // A configured database that does not exist cannot be this file.
    }
    if (other && other.ino === stat.ino && other.dev === stat.dev) refuse('it is a hard link to a live database.')
  }
  if (opts.discovery.referencedPaths.includes(real)) refuse('a running pm2 process references this path.')

  const relative = path.relative(home, real)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    const segments = relative.split(path.sep)
    if (segments[0]?.startsWith('.canonry') && !segments.slice(1, -1).some(segment => SCRATCH_SEGMENT.test(segment))) {
      refuse('it is inside a ~/.canonry* directory and not in a tmp or scratch folder there.')
    }
  }

  const holders = (opts.holders ?? processesHoldingFile)(real)
  if (holders.length > 0) refuse(`another process (pid ${holders.join(', ')}) has it open.`)
  return real
}

// ───────────────────────────── request guard ─────────────────────────────

export interface RegistryToolLike {
  name: string
  access: 'read' | 'write'
  annotations?: { openWorldHint?: boolean }
  openApiOperations: string[]
}

export type PolicyVerdict = { allow: true } | { allow: false; reason: string }

export interface RequestPolicy {
  check(method: string, url: string): PolicyVerdict
}

export const EVAL_BLOCKED_MESSAGE =
  'Blocked by the Aero eval harness: this call would change data or reach an outside service, and the eval runs on a database copy with provider work off. Answer from the data you can read.'

function operationPattern(template: string): RegExp {
  const escaped = template
    .replace(/\/+$/, '')
    .split(/\{[^}]+\}/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  return new RegExp(`^${escaped}/?$`)
}

/** The agent's own routes the eval drives. */
const AGENT_WRITES: Array<[string, RegExp]> = [
  ['POST', /^\/api\/v1\/projects\/[^/]+\/agent\/prompt\/?$/],
  ['DELETE', /^\/api\/v1\/projects\/[^/]+\/agent\/transcript\/?$/],
]

/**
 * Reads pass; writes are refused except the agent's prompt and reset and the
 * few read tools that use a non-GET verb (a preview). A read tool that calls a
 * provider or outside service live (`openWorldHint`, or named in
 * `extraBlockedTools`) is refused too.
 */
export function buildRequestPolicy(tools: readonly RegistryToolLike[], extraBlockedTools: ReadonlySet<string> = new Set()): RequestPolicy {
  const blockedReads: Array<[string, RegExp]> = []
  const allowedWrites: Array<[string, RegExp]> = [...AGENT_WRITES]
  for (const tool of tools) {
    if (tool.access !== 'read') continue
    const live = tool.annotations?.openWorldHint === true || extraBlockedTools.has(tool.name)
    for (const op of tool.openApiOperations) {
      const [method, template] = op.split(/\s+/, 2) as [string, string | undefined]
      if (!template) continue
      const entry: [string, RegExp] = [method.toUpperCase(), operationPattern(template)]
      if (live) blockedReads.push(entry)
      else if (entry[0] !== 'GET') allowedWrites.push(entry)
    }
  }
  return {
    check(method, url) {
      const verb = method.toUpperCase()
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(url, 'http://127.0.0.1').pathname)
      } catch {
        return { allow: false, reason: 'unparseable path' }
      }
      if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') {
        const hit = blockedReads.find(([m, re]) => (m === 'GET' || m === verb) && re.test(pathname))
        return hit ? { allow: false, reason: 'live provider read' } : { allow: true }
      }
      if (allowedWrites.some(([m, re]) => m === verb && re.test(pathname))) return { allow: true }
      return { allow: false, reason: 'write' }
    },
  }
}

export interface BlockedRequest {
  method: string
  path: string
  reason: string
  at: string
}

// ───────────────────────────── project helpers ─────────────────────────────

export function findProject(db: DatabaseClient, name: string): { id: string; name: string } | null {
  return db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.name, name)).get() ?? null
}

/**
 * Advanced, legacy or simple, decided exactly as `src/agent/project-shape.ts`
 * decides it: the active plan version's schema, or no plan at all.
 */
export function detectProjectKind(db: DatabaseClient, projectId: string): ProjectKind {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
  const version = pointer
    ? db.select().from(measurementPlanVersions).where(and(
        eq(measurementPlanVersions.projectId, projectId),
        eq(measurementPlanVersions.id, pointer.activeVersionId),
      )).get()
    : undefined
  if (!version) return 'simple'
  let schemaVersion: number | undefined
  try {
    schemaVersion = (JSON.parse(version.canonicalJson) as { schemaVersion?: number }).schemaVersion
  } catch {
    schemaVersion = undefined
  }
  return (schemaVersion ?? version.schemaVersion) === MEASUREMENT_PLAN_V2_SCHEMA_VERSION ? 'advanced' : 'legacy'
}

// ───────────────────────────── cost ─────────────────────────────

/**
 * Aero spend from `llm_usage_events` rows written after a mark. Null when no
 * row was written, or when rows carry tokens but no price (a model pi-ai has
 * no price for).
 */
export function createDbCostReader(db: DatabaseClient, projectId: string): CostReader {
  const sqlite = db.$client
  return {
    mark() {
      return (sqlite.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM llm_usage_events').get() as { m: number }).m
    },
    since(mark: number): CostSnapshot {
      const rows = sqlite.prepare(
        `SELECT provider, model, cost_millicents AS cost, total_tokens AS tokens
           FROM llm_usage_events
          WHERE rowid > ? AND project_id = ? AND feature LIKE 'aero%'`,
      ).all(mark, projectId) as Array<{ provider: string; model: string; cost: number; tokens: number }>
      const models = [...new Set(rows.map(row => `${row.provider}/${row.model}`))]
      const millicents = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
      const tokens = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
      const unpriced = rows.some(row => !row.cost && row.tokens > 0)
      return {
        costUsd: rows.length === 0 || unpriced ? null : millicents / 100_000,
        models,
        tokens,
      }
    },
  }
}

// ───────────────────────────── the target ─────────────────────────────

export interface TargetOptions {
  /** A database COPY. Refused when it looks live. */
  db: string
  /** A Canonry config dir; only its config.yaml is read, and only a temp copy is used. */
  sourceConfigDir: string
  /** Checked to exist when given. */
  project?: string
  log?: (line: string) => void
  /** Test seams for the live-database guard. Production leaves both unset. */
  guard?: { discovery?: LiveDatabaseDiscovery; holders?: (file: string) => number[] }
}

export interface EvalTarget extends RunnerTarget {
  baseUrl: string
  /** Bearer header for the install key from the config. */
  adminHeaders: Record<string, string>
  /** Cookie + origin for a throwaway viewer, or null when the config does not allow viewers. */
  viewerHeaders: Record<string, string> | null
  viewerUnavailableReason?: string
  laneAvailable(lane: EvalLane): boolean
  db: DatabaseClient
  dbPath: string
  /** Private temp dir holding the config copy; removed on close. */
  workDir: string
  projectId: string | null
  /** provider/model the config resolves Aero to (the transcript row can still override it). */
  configuredAeroModel: string
  /** Requests the guard refused, in order. */
  blocked: BlockedRequest[]
  notes: string[]
  close(): Promise<void>
}

/** Viewer turns are capped per account per day (50); rotate accounts well before that. */
const VIEWER_TURNS_PER_ACCOUNT = 40

const ENV_OVERRIDES: Record<string, string | undefined> = {
  CANONRY_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  CANONRY_DISABLE_UPDATE_CHECK: '1',
  // Aero answers when asked and never wakes itself.
  CANONRY_AGENT_PROMPT_ONLY: '1',
  // On even when the source config disabled it: the eval exists to ask it.
  CANONRY_AGENT_DISABLED: '0',
  // Aero never loads tools from remote MCP servers in the eval.
  CANONRY_EXTERNAL_MCP: undefined,
  CANONRY_PORT: undefined,
  CANONRY_HOST: undefined,
  CANONRY_BASE_PATH: undefined,
  CANONRY_TRUST_PROXY: undefined,
}

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => probe.close(() => resolve()))
  if (!port) throw new Error('Could not find a free port.')
  return port
}

function writePrivateFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export async function startTarget(opts: TargetOptions): Promise<EvalTarget> {
  const log = opts.log ?? (() => {})
  const sourceConfig = path.join(opts.sourceConfigDir, 'config.yaml')
  if (!fs.existsSync(sourceConfig)) throw new Error(`No config.yaml in ${opts.sourceConfigDir}.`)
  const discovery = opts.guard?.discovery ?? discoverLiveDatabases()
  const dbPath = assertSafeDatabasePath(opts.db, { discovery, configDirs: [opts.sourceConfigDir], holders: opts.guard?.holders })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-aero-eval-'))
  fs.chmodSync(tempDir, 0o700)
  const configDir = path.join(tempDir, 'config')
  const assetsDir = path.join(tempDir, 'assets')
  fs.mkdirSync(configDir, { mode: 0o700 })
  fs.mkdirSync(assetsDir, { mode: 0o700 })
  // The temp dir holds a copy of the config, keys included. If the process
  // exits without close() (an interrupt during setup), still remove it.
  const removeTempDir = () => fs.rmSync(tempDir, { recursive: true, force: true })
  process.once('exit', removeTempDir)

  const savedEnv = new Map<string, string | undefined>()
  const setEnv = (key: string, value: string | undefined) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const restoreEnv = () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  let db: DatabaseClient | undefined
  let app: Awaited<ReturnType<typeof import('../../src/server.js')['createServer']>> | undefined
  const createdUserIds: string[] = []
  const createdKeyIds: string[] = []

  let closed = false
  const cleanup = async () => {
    if (closed) return
    closed = true
    if (app) {
      const server = app.server
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await app.close().catch(() => {})
    }
    if (db) {
      try {
        if (createdUserIds.length > 0) db.delete(users).where(inArray(users.id, createdUserIds)).run()
        if (createdKeyIds.length > 0) db.delete(apiKeys).where(inArray(apiKeys.id, createdKeyIds)).run()
      } catch {
        // The copy is disposable; leftover throwaway rows are harmless.
      }
      try {
        db.$client.close()
      } catch {
        // Already closed.
      }
    }
    restoreEnv()
    removeTempDir()
    process.off('exit', removeTempDir)
  }

  try {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const raw = (parseYaml(fs.readFileSync(sourceConfig, 'utf8')) ?? {}) as Record<string, unknown>
    raw.database = dbPath
    raw.apiUrl = baseUrl
    raw.port = port
    raw.updateCheck = false
    raw.telemetry = false
    for (const key of ['basePath', 'publicUrl', 'externalMcpServers']) delete raw[key]
    writePrivateFile(path.join(configDir, 'config.yaml'), stringifyYaml(raw))

    setEnv('CANONRY_CONFIG_DIR', configDir)
    for (const [key, value] of Object.entries(ENV_OVERRIDES)) setEnv(key, value)

    const { loadConfig } = await import('../../src/config.js')
    const config: CanonryConfig = loadConfig()
    config.database = dbPath
    config.apiUrl = baseUrl
    config.port = port
    delete config.externalMcpServers
    delete config.basePath

    db = createClient(dbPath)
    migrate(db)

    let projectId: string | null = null
    if (opts.project) {
      const project = findProject(db, opts.project)
      if (!project) throw new Error(`Project "${opts.project}" is not in this database.`)
      projectId = project.id
    }

    const notes = [...discovery.notes]
    // The install key must be a live wildcard key in the copy: Aero's tools run with it.
    const keyRow = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(config.apiKey))).get()
    const keyUsable = keyRow && !keyRow.revokedAt && Array.isArray(keyRow.scopes) && (keyRow.scopes as string[]).includes('*')
    if (!keyUsable) {
      const minted = `cnry_${crypto.randomBytes(24).toString('hex')}`
      const id = `aero-eval-${crypto.randomUUID()}`
      db.insert(apiKeys).values({
        id,
        name: 'aero-eval',
        keyHash: hashApiKey(minted),
        keyPrefix: minted.slice(0, 9),
        scopes: ['*'],
        createdAt: new Date().toISOString(),
      }).run()
      createdKeyIds.push(id)
      config.apiKey = minted
      notes.push('The config\'s install key is not a live wildcard key in this copy; the eval minted a throwaway one in the copy.')
    }

    const [{ createServer }, { canonryMcpTools }, { AERO_VIEWER_EXCLUDED_MCP_TOOLS }, { resolveAgentAllowViewers }, { resolveSessionProviderAndModel }] = await Promise.all([
      import('../../src/server.js'),
      import('../../src/mcp/tool-registry.js'),
      import('../../src/agent/viewer-sessions.js'),
      import('../../src/agent-config.js'),
      import('../../src/agent/session.js'),
    ])

    app = await createServer({ config, db, logger: false, host: '127.0.0.1', assetsDir })
    await app.ready()

    // Local reads the viewer list excludes for privacy, not because they call out.
    const localReads = new Set(['canonry_settings_get', 'canonry_history_global'])
    const liveReads = new Set([...AERO_VIEWER_EXCLUDED_MCP_TOOLS].filter(name => !localReads.has(name)))
    const policy = buildRequestPolicy(canonryMcpTools as unknown as RegistryToolLike[], liveReads)
    const blocked: BlockedRequest[] = []
    const server = app.server
    const handlers = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>
    if (handlers.length === 0) throw new Error('Fastify attached no request handler; cannot install the request guard.')
    server.removeAllListeners('request')
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const verdict = policy.check(req.method ?? 'GET', req.url ?? '/')
      if (!verdict.allow) {
        const entry = { method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0]!, reason: verdict.reason, at: new Date().toISOString() }
        blocked.push(entry)
        log(`guard: refused ${entry.method} ${entry.path} (${entry.reason})`)
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'EVAL_BLOCKED', message: EVAL_BLOCKED_MESSAGE } }))
        return
      }
      for (const handler of handlers) handler.call(server, req, res)
    })
    // Raw listen on purpose: Fastify's onListen hook starts the scheduler,
    // the site-liveness loop and research re-dispatch. None of it runs here.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const adminHeaders = { authorization: `Bearer ${config.apiKey}` }

    const allowViewers = resolveAgentAllowViewers(process.env, config)
    const viewerUnavailableReason = allowViewers
      ? undefined
      : 'This config does not let viewers use Aero (agent.allowViewers is not true).'
    const mintViewer = (): Record<string, string> => {
      const id = `aero-eval-viewer-${crypto.randomUUID()}`
      const name = `aero-eval-viewer-${id.slice(-12)}`
      db!.insert(users).values({
        id,
        name,
        nameKey: name.toLowerCase(),
        // Not a password digest, so no sign-in can ever match it.
        passwordHash: `!aero-eval-no-login!${crypto.randomBytes(16).toString('hex')}`,
        role: 'viewer',
        createdAt: new Date().toISOString(),
      }).run()
      createdUserIds.push(id)
      const token = createUserSession(db!, id)
      // A cookie-carried write must name this server as its origin.
      return { cookie: `${USER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`, origin: baseUrl }
    }
    let viewerHeaders = allowViewers ? mintViewer() : null
    let viewerTurns = 0

    let configuredAeroModel = 'unknown'
    try {
      const resolved = resolveSessionProviderAndModel(config)
      configuredAeroModel = `${resolved.provider}/${resolved.modelId}`
    } catch {
      notes.push('No Aero provider key resolves from this config; turns will fail.')
    }

    log(`serving ${path.basename(dbPath)} at ${baseUrl} (scheduler off, Aero prompt-only, guard on)`)

    const target: EvalTarget = {
      baseUrl,
      adminHeaders,
      get viewerHeaders() {
        return viewerHeaders
      },
      viewerUnavailableReason,
      laneAvailable: lane => lane === 'admin' || viewerHeaders !== null,
      headers(lane) {
        if (lane === 'admin') return adminHeaders
        if (!viewerHeaders) throw new Error(viewerUnavailableReason ?? 'Viewer lane unavailable.')
        if (viewerTurns >= VIEWER_TURNS_PER_ACCOUNT) {
          viewerHeaders = mintViewer()
          viewerTurns = 0
        }
        viewerTurns++
        return viewerHeaders
      },
      costReader: projectId ? createDbCostReader(db, projectId) : undefined,
      // The same project-shape text Aero's system prompt gets on both lanes,
      // read per turn from the copy, so the checks and the grader can ground
      // the counts it states.
      systemContext: () => (projectId ? aeroProjectShape(db!, projectId).prompt.trim() || undefined : undefined),
      db,
      dbPath,
      workDir: tempDir,
      projectId,
      configuredAeroModel,
      blocked,
      notes,
      close: cleanup,
    }
    return target
  } catch (error) {
    await cleanup()
    throw error
  }
}
