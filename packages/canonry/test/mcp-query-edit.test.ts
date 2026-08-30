import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../src/client.js'
import { MCP_OPENAPI_OPERATION_CLASSIFICATIONS } from '../src/mcp/openapi-classification.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

function toolFor(name: string) {
  const tool = canonryMcpTools.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Missing MCP tool: ${name}`)
  return tool
}

describe('canonry_query_edit', () => {
  it('forwards one raw-CAS query replacement without using bulk query APIs', async () => {
    const tool = toolFor('canonry_query_edit')
    const replaceQuery = vi.fn().mockResolvedValue({
      id: 'query-replacement',
      query: 'new question',
      createdAt: '2026-08-30T12:00:00.000Z',
    })
    const parsed = tool.inputSchema.parse({
      project: 'demo',
      queryId: 'query-original',
      request: {
        query: 'new question',
        expectedQuery: '  saved question  ',
      },
    })

    await expect(tool.handler({ replaceQuery } as unknown as ApiClient, parsed)).resolves.toEqual({
      id: 'query-replacement',
      query: 'new question',
      createdAt: '2026-08-30T12:00:00.000Z',
    })

    expect(replaceQuery).toHaveBeenCalledWith('demo', 'query-original', {
      query: 'new question',
      expectedQuery: '  saved question  ',
    })
    expect(tool.access).toBe('write')
    expect(tool.tier).toBe('setup')
    expect(tool.openApiOperations).toEqual(['POST /api/v1/projects/{name}/queries/{id}/replace'])
    expect(MCP_OPENAPI_OPERATION_CLASSIFICATIONS['POST /api/v1/projects/{name}/queries/{id}/replace']).toBe('included')
  })
})
