import { afterEach, expect, it, vi } from 'vitest'
import { agentConversations } from '../src/commands/agent-conversations.js'
import { CliError } from '../src/cli-error.js'
const client = vi.hoisted(() => ({ listAgentConversations: vi.fn(), createAgentConversation: vi.fn(), getAgentConversation: vi.fn(), resumeAgentConversation: vi.fn(), deleteAgentConversation: vi.fn() }))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = 0 })
it.each(['json', 'jsonl'] as const)('CLI %s matches the API result without adding display fields', async format => {
  const result = { conversations: [], currentConversationId: null, nextOffset: 50 }
  client.listAgentConversations.mockResolvedValue(result)
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
  await agentConversations({ project: 'demo', action: 'list', offset: 0, limit: 50, format })
  expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(result)
  expect(client.listAgentConversations).toHaveBeenCalledWith('demo', { offset: 0, limit: 50 })
})
it.each([['new', 'createAgentConversation'], ['show', 'getAgentConversation'], ['resume', 'resumeAgentConversation'], ['delete', 'deleteAgentConversation']] as const)('CLI %s forwards the exact selected conversation', async (action, method) => {
  const result = { id: 'conversation', status: 'deleted' }
  client[method].mockResolvedValue(result)
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
  await agentConversations({ project: 'demo', action, id: 'conversation', format: 'json' })
  expect(client[method]).toHaveBeenCalledWith('demo', 'conversation')
  expect(JSON.parse(stdout.mock.calls[0][0])).toEqual(result)
})
it('CLI reports API failures on stderr and keeps stdout empty', async () => {
  client.listAgentConversations.mockRejectedValue(new CliError({ code: 'FORBIDDEN', message: 'forbidden', exitCode: 1 }))
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  await agentConversations({ project: 'demo', action: 'list', format: 'json' })
  expect(stdout).not.toHaveBeenCalled()
  expect(stderr).toHaveBeenCalled()
  expect(process.exitCode).toBe(1)
})
