import type { Api, Model } from '@mariozechner/pi-ai'

const AERO_MEMORY_SEPARATOR = '\n\n---\n\n'
const AERO_MEMORY_BLOCK_PREFIX = `${AERO_MEMORY_SEPARATOR}<memory>\n`

interface TextSystemBlock {
  type: 'text'
  text: string
  cache_control?: unknown
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isTextSystemBlock(value: unknown): value is TextSystemBlock {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string'
}

export interface SplitAeroSystemPrompt {
  basePrompt: string
  memoryBlock?: string
}

/**
 * SessionRegistry appends dynamic project memory as:
 *
 *   <base prompt>
 *   ---
 *   <memory>...</memory>
 *
 * Keep that dynamic block outside the cached system breakpoint so Anthropic can
 * reuse the stable Aero prompt even as project memory changes.
 */
export function splitAeroHydratedSystemPrompt(systemPrompt: string): SplitAeroSystemPrompt {
  const idx = systemPrompt.lastIndexOf(AERO_MEMORY_BLOCK_PREFIX)
  if (idx < 0) return { basePrompt: systemPrompt }
  return {
    basePrompt: systemPrompt.slice(0, idx).trimEnd(),
    memoryBlock: systemPrompt.slice(idx + AERO_MEMORY_SEPARATOR.length),
  }
}

/**
 * pi-ai emits one Anthropic system text block with cache_control. When that
 * block contains hydrated memory, replace it with two blocks:
 *   1. stable Aero base prompt, still cacheable
 *   2. dynamic memory block, not cacheable
 *
 * Return undefined when the payload should be left unchanged, matching pi-ai's
 * onPayload convention.
 */
export function splitAeroAnthropicSystemCachePayload(
  payload: unknown,
  model: Model<Api>,
): unknown | undefined {
  if (model.api !== 'anthropic-messages') return undefined
  if (!isRecord(payload) || !Array.isArray(payload.system)) return undefined

  let changed = false
  const nextSystem: unknown[] = []

  for (const block of payload.system) {
    if (!isTextSystemBlock(block)) {
      nextSystem.push(block)
      continue
    }

    const split = splitAeroHydratedSystemPrompt(block.text)
    if (!split.memoryBlock) {
      nextSystem.push(block)
      continue
    }

    const memoryBlock: TextSystemBlock = {
      ...block,
      text: split.memoryBlock,
    }
    delete memoryBlock.cache_control

    nextSystem.push({
      ...block,
      text: split.basePrompt,
    })
    nextSystem.push(memoryBlock)
    changed = true
  }

  if (!changed) return undefined
  return {
    ...payload,
    system: nextSystem,
  }
}
