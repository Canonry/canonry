import { expect, it } from 'vitest'
import { competitorChangePreviewRequestSchema } from '@canonry/canonry-contracts'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

it('uses the same replacement domain contract in MCP and HTTP', () => {
  const tool = canonryMcpTools.find(tool => tool.name === 'canonry_competitors_change_preview')!
  for (const competitors of [['rival.example'], [{ domain: 'rival.example', aliases: ['Rival Name'] }]]) {
    const request = { change: 'replace', competitors }
    expect(tool.inputSchema.safeParse({ project: 'demo', ...request }).success)
      .toBe(competitorChangePreviewRequestSchema.safeParse(request).success)
  }
})
