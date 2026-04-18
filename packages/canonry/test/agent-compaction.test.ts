import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  agentMemory,
  createClient,
  migrate,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { MemorySources } from '@ainyc/canonry-contracts'
import type { Api, Model } from '@mariozechner/pi-ai'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { and, eq, like } from 'drizzle-orm'
import {
  COMPACTION_MAX_MESSAGES,
  COMPACTION_PRESERVE_TAIL_MESSAGES,
  COMPACTION_TOKEN_THRESHOLD,
} from '../src/agent/compaction-config.js'
import {
  compactMessages,
  findSafeSplit,
  shouldCompact,
} from '../src/agent/compaction.js'
import { COMPACTION_KEY_PREFIX } from '../src/agent/memory-store.js'

function userMsg(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 0 } as AgentMessage
}

function assistantTextMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'faux-api',
    provider: 'faux',
    model: 'faux-model',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  } as AgentMessage
}

function insertProject(db: DatabaseClient, name: string): string {
  const id = `proj_${name}_${Math.random().toString(36).slice(2)}`
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example.com`,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

const FAUX_MODEL = { id: 'faux-model', provider: 'faux', api: 'faux-api' } as unknown as Model<Api>

describe('shouldCompact', () => {
  it('returns false for an empty transcript', () => {
    expect(shouldCompact([])).toBe(false)
  })

  it('returns true when message count crosses the hard cap', () => {
    const messages: AgentMessage[] = Array.from(
      { length: COMPACTION_MAX_MESSAGES },
      () => userMsg('x'),
    )
    expect(shouldCompact(messages)).toBe(true)
  })

  it('returns true when estimated tokens cross the threshold', () => {
    // Each char ≈ 0.25 tokens. We want tokens ≥ threshold: content length ≥ threshold * 4.
    const contentLen = COMPACTION_TOKEN_THRESHOLD * 4
    const msg = userMsg('x'.repeat(contentLen))
    expect(shouldCompact([msg])).toBe(true)
  })

  it('returns false when under both caps', () => {
    const messages = [userMsg('hello'), assistantTextMsg('hi')]
    expect(shouldCompact(messages)).toBe(false)
  })
})

describe('findSafeSplit', () => {
  it('returns 0 when the transcript is too short to preserve a tail', () => {
    const short: AgentMessage[] = Array.from(
      { length: COMPACTION_PRESERVE_TAIL_MESSAGES },
      (_, i) => (i === 0 ? userMsg('u') : assistantTextMsg('a')),
    )
    expect(findSafeSplit(short, 0)).toBe(0)
  })

  it('snaps forward to the next UserMessage boundary', () => {
    const msgs: AgentMessage[] = [
      userMsg('u1'),            // 0
      assistantTextMsg('a1'),   // 1
      userMsg('u2'),            // 2  ← expected split
      assistantTextMsg('a2'),   // 3
      userMsg('u3'),            // 4
      assistantTextMsg('a3'),   // 5
      userMsg('u4'),            // 6
      assistantTextMsg('a4'),   // 7
      userMsg('u5'),            // 8
      assistantTextMsg('a5'),   // 9
      userMsg('u6'),            // 10
      assistantTextMsg('a6'),   // 11
      userMsg('u7'),            // 12
      assistantTextMsg('a7'),   // 13
      userMsg('u8'),            // 14
      assistantTextMsg('a8'),   // 15
      userMsg('u9'),            // 16
      assistantTextMsg('a9'),   // 17
      userMsg('u10'),           // 18
      assistantTextMsg('a10'),  // 19
      userMsg('u11'),           // 20
      assistantTextMsg('a11'),  // 21
    ]
    // target=1 → scan forward from 1, first user is idx 2
    expect(findSafeSplit(msgs, 1)).toBe(2)
  })

  it('returns 0 when no user-message boundary exists before the tail cap', () => {
    // Only the first message is a user; everything else is assistant.
    const msgs: AgentMessage[] = [
      userMsg('u1'),
      ...Array.from({ length: 20 }, () => assistantTextMsg('a')),
    ]
    // maxSplit = 21 - 10 = 11. Scan from 5 (target) → no user found before idx 11.
    expect(findSafeSplit(msgs, 5)).toBe(0)
  })
})

describe('compactMessages', () => {
  let tmpDir: string
  let db: DatabaseClient
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-compaction-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = insertProject(db, 'demo')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no safe split exists', async () => {
    // All-assistant transcript with a single leading user → no user boundary
    // within the splittable prefix, so compaction bails.
    const messages: AgentMessage[] = [
      userMsg('hi'),
      ...Array.from({ length: 20 }, () => assistantTextMsg('a')),
    ]
    const result = await compactMessages({
      db,
      projectId,
      sessionId: 'session-abc',
      messages,
      model: FAUX_MODEL,
      summarize: async () => 'should not be called',
    })
    expect(result).toBeNull()
  })

  it('summarizes the prefix, persists a compaction note, and returns the suffix', async () => {
    const messages: AgentMessage[] = [
      userMsg('u1'),          // 0
      assistantTextMsg('a1'), // 1
      userMsg('u2'),          // 2
      assistantTextMsg('a2'), // 3
      userMsg('u3'),          // 4
      assistantTextMsg('a3'), // 5
      userMsg('u4'),          // 6
      assistantTextMsg('a4'), // 7
      userMsg('u5'),          // 8
      assistantTextMsg('a5'), // 9
      userMsg('u6'),          // 10
      assistantTextMsg('a6'), // 11
      userMsg('u7'),          // 12
      assistantTextMsg('a7'), // 13
      userMsg('u8'),          // 14
      assistantTextMsg('a8'), // 15
      userMsg('u9'),          // 16
      assistantTextMsg('a9'), // 17
      userMsg('u10'),         // 18
      assistantTextMsg('a10'),// 19
      userMsg('u11'),         // 20
      assistantTextMsg('a11'),// 21
    ]

    const summarizeCalls: AgentMessage[][] = []
    const result = await compactMessages({
      db,
      projectId,
      sessionId: 'session-abc',
      messages,
      model: FAUX_MODEL,
      summarize: async (args) => {
        summarizeCalls.push(args.chunk.slice())
        return '- User asked about status\n- Agent ran a sweep and produced insights.'
      },
    })

    expect(result).not.toBeNull()
    expect(summarizeCalls).toHaveLength(1)
    expect(result!.removedCount).toBeGreaterThan(0)
    expect(result!.messages.length).toBeLessThan(messages.length)
    expect(result!.messages.length).toBeGreaterThanOrEqual(COMPACTION_PRESERVE_TAIL_MESSAGES)
    // The suffix begins on a user-message boundary — compaction must not
    // orphan an assistant turn from its matching user message.
    expect(result!.messages[0].role).toBe('user')

    // Persisted a compaction:-prefixed memory row for this session.
    const rows = db
      .select()
      .from(agentMemory)
      .where(and(
        eq(agentMemory.projectId, projectId),
        like(agentMemory.key, `${COMPACTION_KEY_PREFIX}session-abc:%`),
      ))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe(MemorySources.compaction)
    expect(rows[0].value).toContain('User asked about status')
  })

  it('truncates an oversize summary to fit the 2 KB memory cap', async () => {
    const messages: AgentMessage[] = [
      userMsg('u1'),
      ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? userMsg(`u${i + 2}`) : assistantTextMsg(`a${i + 1}`))),
    ]

    const oversize = 'x'.repeat(5000)
    const result = await compactMessages({
      db,
      projectId,
      sessionId: 'session-big',
      messages,
      model: FAUX_MODEL,
      summarize: async () => oversize,
    })

    expect(result).not.toBeNull()
    const rows = db
      .select()
      .from(agentMemory)
      .where(and(
        eq(agentMemory.projectId, projectId),
        like(agentMemory.key, `${COMPACTION_KEY_PREFIX}session-big:%`),
      ))
      .all()
    expect(rows).toHaveLength(1)
    // Must fit under the 2 KB cap and end with the truncation marker.
    expect(Buffer.byteLength(rows[0].value, 'utf8')).toBeLessThanOrEqual(2048)
    expect(rows[0].value.endsWith('…[truncated]')).toBe(true)
  })

  it('propagates summarizer errors so callers can log and skip compaction', async () => {
    const messages: AgentMessage[] = [
      userMsg('u1'),
      ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? userMsg(`u${i + 2}`) : assistantTextMsg(`a${i + 1}`))),
    ]

    await expect(
      compactMessages({
        db,
        projectId,
        sessionId: 'session-fail',
        messages,
        model: FAUX_MODEL,
        summarize: async () => {
          throw new Error('provider rate limited')
        },
      }),
    ).rejects.toThrow(/provider rate limited/)

    // No compaction note should have been written.
    const rows = db
      .select()
      .from(agentMemory)
      .where(and(
        eq(agentMemory.projectId, projectId),
        like(agentMemory.key, `${COMPACTION_KEY_PREFIX}session-fail:%`),
      ))
      .all()
    expect(rows).toHaveLength(0)
  })
})
