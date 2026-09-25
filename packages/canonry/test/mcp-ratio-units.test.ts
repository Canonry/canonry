import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { RATIO_UNIT_META_KEY, fraction, undeclaredRatioFields } from '@ainyc/canonry-contracts'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

/**
 * An MCP client reads a tool's result through its output schema, so a ratio
 * there has to say whether 2.07 means 2.07% or 207% just as it does in the
 * OpenAPI document. The schemas are converted the way `src/mcp/schema.ts`
 * converts them for the wire.
 */
function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
}

describe('ratio units in MCP tool schemas', () => {
  const withOutput = canonryMcpTools.filter(tool => tool.outputSchema !== undefined)

  test('there are output schemas to check', () => {
    expect(withOutput.length).toBeGreaterThan(0)
  })

  test('every ratio-named number in a tool output schema declares its unit', () => {
    const missing = withOutput.flatMap(tool => undeclaredRatioFields(outputJsonSchema(tool.outputSchema!), `${tool.name}.output`))
    expect(missing.sort()).toEqual([])
  })

  test('every ratio-named number in a tool input schema declares its unit', () => {
    const missing = canonryMcpTools.flatMap(tool => undeclaredRatioFields(tool.inputJsonSchema as Record<string, unknown>, `${tool.name}.input`))
    expect(missing.sort()).toEqual([])
  })

  test('the draft-7 conversion keeps a declared unit and the walker reports an undeclared one', () => {
    const declared = outputJsonSchema(z.object({ rows: z.array(z.object({ ctr: fraction().nullable() })) }))
    expect(JSON.stringify(declared)).toContain(`"${RATIO_UNIT_META_KEY}":"fraction"`)
    expect(undeclaredRatioFields(declared, 'probe.output')).toEqual([])
    const undeclared = outputJsonSchema(z.object({ rows: z.array(z.object({ ctr: z.number().nullable() })) }))
    expect(undeclaredRatioFields(undeclared, 'probe.output')).toEqual(['probe.output.rows[].ctr'])
  })
})
