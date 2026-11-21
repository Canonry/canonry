import { describe, expect, it } from 'vitest'
import { releaseChangesUrl, releaseHighlights, releaseHighlightsForVersion } from '../src/lib/release-notes.js'

describe('releaseHighlights', () => {
  const highlights = [{ text: expect.any(String), action: { label: 'Join our Discord', href: 'https://discord.gg/8K9yY7GywJ', icon: 'Discord' } }]

  it('introduces only the exact stable build on the first visit', () => {
    expect(releaseHighlightsForVersion('7.117.0')).toEqual(highlights)
    expect(releaseHighlightsForVersion('7.117.0+custom-build')).toEqual(highlights)
    expect(releaseHighlightsForVersion('7.117.0-rc.1+custom-build')).toEqual([])
    expect(releaseHighlightsForVersion('7.118.0')).toEqual([])
    expect(releaseHighlightsForVersion('7.117.0+')).toEqual([])
  })

  it('includes notes for the installed version and skipped releases', () => {
    expect(releaseHighlights('7.116.1', '7.117.0')).toEqual(highlights)
    expect(releaseHighlights('7.116.1', '7.120.0')).toEqual(highlights)
  })

  it('selects the available dashboard feature for both exact and skipped releases', () => {
    const updateNote = [{ text: 'Dismiss a release note once to clear it across tabs and on your next visit.' }]
    expect(releaseHighlightsForVersion('7.117.0', false)).toEqual(updateNote)
    expect(releaseHighlights('7.116.1', '7.118.0', false)).toEqual(updateNote)
  })

  it('skips releases already seen, downgrades, and unknown versions', () => {
    expect(releaseHighlights('7.117.0', '7.117.0')).toEqual([])
    expect(releaseHighlights('7.117.0', '7.117.1')).toEqual([])
    expect(releaseHighlights('7.117.1', '7.116.1')).toEqual([])
    expect(releaseHighlights('unknown', '7.117.0')).toEqual([])
    expect(releaseHighlights('7.116.1', 'latest')).toEqual([])
  })

  it('shows stable notes when a prerelease is upgraded to its stable release', () => {
    expect(releaseHighlights('7.116.1', '7.117.0-rc.1')).toEqual([])
    expect(releaseHighlights('7.117.0-rc.1', '7.117.0+build-stamp')).toEqual(highlights)
    expect(releaseHighlights('7.117.0+build-stamp', '7.117.1')).toEqual([])
  })
})

describe('releaseChangesUrl', () => {
  const previous = '67b40e10c671a2345678a9012345678901234567'
  const current = 'fd346781fedcba9876543210fedcba9876543210'
  const github = 'https://github.com/Canonry/canonry'
  const npm = 'https://www.npmjs.com/package/@canonry/canonry'

  it('compares distinct Git SHAs', () => {
    expect(releaseChangesUrl(previous, current, '7.117.0')).toBe(`${github}/compare/${previous}...${current}`)
  })

  it('anchors history to the current commit when there is no distinct prior commit', () => {
    for (const prior of [undefined, 'feature/test', current, current.slice(0, 7).toUpperCase()]) {
      expect(releaseChangesUrl(prior, current, '7.117.0')).toBe(`${github}/commits/${current}`)
    }
  })

  it('uses the exact npm version when the current commit is missing or invalid', () => {
    for (const commit of [undefined, 'main', 'abcdef0?tab=readme']) {
      expect(releaseChangesUrl(previous, commit, '7.117.0')).toBe(`${npm}/v/7.117.0`)
    }
    expect(releaseChangesUrl(previous, undefined, '7.117.0+local')).toBe(`${npm}/v/7.117.0%2Blocal`)
    expect(releaseChangesUrl(undefined, undefined, '../latest')).toBe(npm)
  })
})
