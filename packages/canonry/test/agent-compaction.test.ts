import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { agentMemory, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { MemorySources } from '@ainyc/canonry-contracts'
import { fauxAssistantMessage, fauxToolCall, type Message, type FauxResponseFactory } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { eq } from 'drizzle-orm'
import { compactMessages, shouldCompact } from '../src/agent/compaction.js'
import { registerAeroFaux, type AeroFaux } from './helpers/aero-faux.js'

function userMsg(content: string, timestamp = 0): AgentMessage {
  return { role: 'user', content, timestamp }
}

function pairs(start: number, turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, offset) => {
    const i = start + offset * 2
    return [userMsg(`u${i}`, i), fauxAssistantMessage(`a${i + 1}`, { timestamp: i + 1 })]
  }).flat()
}

const installedSystem = {
  role: 'system', content: [{ type: 'text', text: 'Installed operator prompt' }], timestamp: -1,
} as AgentMessage

function insertProject(db: DatabaseClient): string {
  const id = 'project-demo'
  const now = new Date().toISOString()
  db.insert(projects).values({
    id, name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example.com',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  return id
}

describe('shouldCompact', () => {
  it('returns false for an empty transcript', () => {
    expect(shouldCompact([])).toBe(false)
  })

  it.each([[399, false], [400, true]] as const)('triggers at the independent %i-message edge: %s', (count, expected) => {
    const messages = Array.from({ length: count }, () => userMsg('x'))
    expect(shouldCompact(messages)).toBe(expected)
    expect(shouldCompact([installedSystem, ...messages])).toBe(expected)
  })

  it('ignores the leading system message pi keeps in the transcript', () => {
    const system = { role: 'system', content: [{ type: 'text', text: 'x'.repeat(480_000) }], timestamp: 0 } as AgentMessage
    expect(shouldCompact([system, userMsg('hi', 1)])).toBe(false)
  })

  it.each([[239_996, false], [240_000, true]] as const)('triggers at the independent %i-character token edge: %s', (characters, expected) => {
    expect(shouldCompact([userMsg('x'.repeat(characters))])).toBe(expected)
  })

  it('returns false when under both caps', () => {
    expect(shouldCompact([userMsg('hello'), fauxAssistantMessage('hi')])).toBe(false)
  })
})

describe('compactMessages', () => {
  let tmpDir: string
  let db: DatabaseClient
  let projectId: string
  let faux: AeroFaux

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-compaction-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = insertProject(db)
    faux = registerAeroFaux({ api: 'faux-api', provider: 'faux', models: [{ id: 'faux-model' }] })
  })

  afterEach(() => {
    faux.unregister()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each([
    ['nine-message transcript', [userMsg('u0'), ...Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`a${i + 1}`, { timestamp: i + 1 }))]],
    ['ten-message minimum tail', [userMsg('u0'), userMsg('u1', 1), ...Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`a${i + 2}`, { timestamp: i + 2 }))]],
    ['no later user boundary', [userMsg('u0'), ...Array.from({ length: 20 }, (_, i) => fauxAssistantMessage(`a${i + 1}`, { timestamp: i + 1 }))]],
    ['user boundary inside the protected tail', [
      userMsg('u0'),
      ...Array.from({ length: 12 }, (_, i) => fauxAssistantMessage(`a${i + 1}`, { timestamp: i + 1 })),
      userMsg('u13', 13),
      ...Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`a${i + 14}`, { timestamp: i + 14 })),
    ]],
  ] satisfies Array<[string, AgentMessage[]]>)('skips %s without calling the provider or writing memory', async (_description, messages) => {
    const original = structuredClone(messages)
    faux.setResponses([fauxAssistantMessage('Unexpected summary')])

    const result = await compactMessages({ db, projectId, sessionId: 'session-skip', messages, model: faux.getModel() })

    expect(faux.state.callCount).toBe(0)
    expect(result).toBeNull()
    expect(db.select().from(agentMemory).where(eq(agentMemory.projectId, projectId)).all()).toEqual([])
    expect(messages).toEqual(original)
  })

  it.each([
    ['plain user boundary', pairs(0, 6), pairs(12, 5), 12],
    ['complete tool-call/result pair', [
      ...pairs(0, 5),
      userMsg('u10', 10),
      fauxAssistantMessage([fauxToolCall('lookup', { query: 'older turn' }, { id: 'older-call' })], { stopReason: 'toolUse', timestamp: 11 }),
      { role: 'toolResult', toolCallId: 'older-call', toolName: 'lookup', content: [{ type: 'text', text: 'Older lookup result' }], isError: false, timestamp: 12 },
    ], [...pairs(13, 5), userMsg('u23', 23)], 13],
  ] satisfies Array<[string, AgentMessage[], AgentMessage[], number]>)('summarizes the exact prefix and preserves the %s tail', async (_description, expectedPrefix, expectedTail, removedCount) => {
    const messages = [installedSystem, ...expectedPrefix, ...expectedTail]
    const original = structuredClone(messages)
    const summary = '- User asked about status\n- Agent ran a sweep and produced insights.'
    const summaryCalls: Message[][] = []
    const respond: FauxResponseFactory = context => {
      summaryCalls.push(context.messages)
      return fauxAssistantMessage(summary)
    }
    faux.setResponses([respond])

    const result = await compactMessages({ db, projectId, sessionId: 'session-policy', messages, model: faux.getModel() })

    expect(faux.state.callCount).toBe(1)
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0].filter(message => message.role === 'system')).toHaveLength(1)
    expect(summaryCalls[0].filter(message => message.role !== 'system')).toEqual(expectedPrefix)
    expect(result).toEqual({ messages: expectedTail, removedCount, summary })
    const rows = db.select().from(agentMemory).where(eq(agentMemory.projectId, projectId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ projectId, source: MemorySources.compaction, value: summary })
    expect(rows[0].key.startsWith('compaction:session-policy:')).toBe(true)
    expect(messages).toEqual(original)
  })

  it.each(['provider failure', 'empty response'] as const)('rejects %s without persisting a note or changing the input transcript', async (failure) => {
    const messages = [...pairs(0, 11)]
    const original = structuredClone(messages)
    const summaryCalls: Message[][] = []
    const respond: FauxResponseFactory = context => {
      summaryCalls.push(context.messages)
      if (failure === 'provider failure') throw new Error('provider rate limited')
      return fauxAssistantMessage('')
    }
    faux.setResponses([respond])

    await expect(compactMessages({ db, projectId, sessionId: 'session-fail', messages, model: faux.getModel() }))
      .rejects.toThrow('summary LLM returned no text content')

    expect(faux.state.callCount).toBe(1)
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0].filter(message => message.role !== 'system')).toEqual(pairs(0, 6))
    expect(db.select().from(agentMemory).where(eq(agentMemory.projectId, projectId)).all()).toEqual([])
    expect(messages).toEqual(original)
  })
})
