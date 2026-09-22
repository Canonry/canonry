import { expect, it } from 'vitest'
import { agentConversationCreateSchema, agentConversationListQuerySchema, agentConversationTitle } from '../src/agent.js'

it('titles conversations from human text with bounded whitespace and length', () => {
  expect(agentConversationTitle([])).toBe('New conversation')
  expect(agentConversationTitle([{ role: 'user', content: '[system] sweep complete' }, { role: 'assistant', content: 'Ignore this' }, { role: 'user', content: [{ type: 'text', text: '  Explain\n London  ' }, { type: 'image', data: 'secret' }, { type: 'text', text: 'results' }] }])).toBe('Explain London results')
  expect(agentConversationTitle([{ role: 'user', content: 'a'.repeat(81) }])).toBe('a'.repeat(79) + '…')
  expect(agentConversationTitle([{ role: 'user', content: 'a'.repeat(80) }])).toBe('a'.repeat(80))
})
it('requires a stable creation ID and validates bounded archive pagination', () => {
  expect(agentConversationCreateSchema.safeParse({}).success).toBe(false)
  expect(agentConversationCreateSchema.safeParse({ id: 'not-an-id' }).success).toBe(false)
  expect(agentConversationListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 })
  expect(agentConversationListQuerySchema.parse({ limit: '100', offset: '7' })).toEqual({ limit: 100, offset: 7 })
  for (const input of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }]) expect(agentConversationListQuerySchema.safeParse(input).success).toBe(false)
})
