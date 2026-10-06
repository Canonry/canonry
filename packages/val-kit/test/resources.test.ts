import { expect, test } from 'vitest'
import { listSkillResources, readSkillResource } from '../src/mcp.js'
import { SKILL_DOCUMENTS } from '../src/mcp/skills/catalog.js'

test('every canonical skill document is advertised and readable without losing its content', () => {
  const advertisedUris = listSkillResources().map(resource => resource.uri).sort()
  const canonicalUris = SKILL_DOCUMENTS.map(document => document.uri).sort()
  expect(advertisedUris).toEqual(canonicalUris)
  expect(new Set(advertisedUris).size).toBe(advertisedUris.length)

  for (const document of SKILL_DOCUMENTS) {
    expect(readSkillResource(document.uri)).toEqual({
      uri: document.uri,
      mimeType: 'text/markdown',
      text: document.content,
    })
  }
})
