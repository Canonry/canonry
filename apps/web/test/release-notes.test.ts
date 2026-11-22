import { expect, it } from 'vitest'
import { availableReleaseNotes } from '../src/lib/release-notes.js'

it('features the Discord welcome invitation from its stable release through later builds', () => {
  const notes = [{
    version: '7.117.0',
    highlights: [expect.objectContaining({
      action: { label: 'Join our Discord', href: 'https://discord.gg/8K9yY7GywJ', icon: 'Discord' },
    })],
  }]
  for (const build of ['7.117.0', '7.117.0+custom-build', '7.117.1+custom-build', '8.0.0-rc.1']) {
    expect(availableReleaseNotes(build)).toEqual(notes)
  }
})

it('excludes future, malformed or inapplicable release highlights', () => {
  for (const build of ['7.116.9', '7.117.0-rc.1+custom-build', '7.118.0-rc.01', '7.117.0+', 'unknown']) {
    expect(availableReleaseNotes(build)).toEqual([])
  }
  expect(availableReleaseNotes('7.118.0', false)).toEqual([])
})
