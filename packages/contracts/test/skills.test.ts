import { describe, expect, it } from 'vitest'
import { classifySkillFile, coerceSkillManifest, SKILL_MANIFEST_FILENAME } from '../src/skills.js'

describe('classifySkillFile', () => {
  it('classifies an absent file as missing regardless of manifest', () => {
    expect(classifySkillFile({ bundledHash: 'a', installedHash: undefined, manifestHash: undefined })).toBe('missing')
    expect(classifySkillFile({ bundledHash: 'a', installedHash: null, manifestHash: 'a' })).toBe('missing')
  })

  it('classifies a byte-identical file as unchanged', () => {
    expect(classifySkillFile({ bundledHash: 'a', installedHash: 'a', manifestHash: 'a' })).toBe('unchanged')
    // Unchanged wins even when the manifest is stale/absent — content is what matters.
    expect(classifySkillFile({ bundledHash: 'a', installedHash: 'a', manifestHash: 'old' })).toBe('unchanged')
    expect(classifySkillFile({ bundledHash: 'a', installedHash: 'a', manifestHash: undefined })).toBe('unchanged')
  })

  it('classifies a file that matches the manifest but not the bundle as stale', () => {
    // canonry wrote `old`; the bundle has since moved to `new`; the operator
    // never touched it → safe to refresh.
    expect(classifySkillFile({ bundledHash: 'new', installedHash: 'old', manifestHash: 'old' })).toBe('stale')
  })

  it('classifies a file that differs from both bundle and manifest as edited', () => {
    expect(classifySkillFile({ bundledHash: 'new', installedHash: 'mine', manifestHash: 'old' })).toBe('edited')
  })

  it('treats a divergent file with no manifest record as edited (conservative)', () => {
    // Without a manifest we cannot prove canonry wrote it, so we never clobber.
    expect(classifySkillFile({ bundledHash: 'new', installedHash: 'mine', manifestHash: undefined })).toBe('edited')
    expect(classifySkillFile({ bundledHash: 'new', installedHash: 'mine', manifestHash: null })).toBe('edited')
  })

  it('exposes the reserved manifest filename as a dotfile', () => {
    expect(SKILL_MANIFEST_FILENAME).toBe('.canonry-skill-manifest.json')
    expect(SKILL_MANIFEST_FILENAME.startsWith('.')).toBe(true)
  })
})

describe('coerceSkillManifest', () => {
  it('returns a well-formed manifest unchanged (same reference)', () => {
    const manifest = { skill: 'aero', version: '1.2.3', files: { 'SKILL.md': 'abc' } }
    expect(coerceSkillManifest(manifest)).toBe(manifest)
    // An empty files map is still a valid manifest.
    expect(coerceSkillManifest({ skill: 'aero', version: '1', files: {} })).not.toBeNull()
  })

  it('returns null for anything without a files object', () => {
    expect(coerceSkillManifest(null)).toBeNull()
    expect(coerceSkillManifest(undefined)).toBeNull()
    expect(coerceSkillManifest(42)).toBeNull()
    expect(coerceSkillManifest('{"files":{}}')).toBeNull()
    expect(coerceSkillManifest({ skill: 'aero', version: '1' })).toBeNull()
    expect(coerceSkillManifest({ files: null })).toBeNull()
  })
})
