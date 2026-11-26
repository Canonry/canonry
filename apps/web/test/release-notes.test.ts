import { expect, it } from 'vitest'
import { availableReleaseNotes, type ReleaseAudience } from '../src/lib/release-notes.js'

const operator: ReleaseAudience = { showResourceLinks: true, whatsNewOnly: false, canWrite: true, showFeedback: true }
const discord = {
  version: '7.117.0',
  highlights: [expect.objectContaining({
    action: { label: 'Join our Discord', href: 'https://discord.gg/8K9yY7GywJ', icon: 'Discord' },
  })],
}
const feedback = {
  version: '7.122.0',
  highlights: [{
    title: 'Send feedback from your agent',
    text: 'Ask your AI agent to send feedback to the Canonry team, or run this in a terminal. It replaces the Feedback button, and API keys are removed before anything is sent.',
    command: 'canonry feedback "what happened"',
  }],
}

it('features the Discord welcome invitation from its stable release through later builds', () => {
  for (const build of ['7.117.0', '7.117.0+custom-build', '7.117.1+custom-build', '7.121.1']) {
    expect(availableReleaseNotes(build)).toEqual([discord])
  }
})

it('adds the feedback note from 7.122.0, newest first, and carries it through later builds', () => {
  for (const build of ['7.122.0', '7.122.3+custom-build', '8.0.0-rc.1']) {
    expect(availableReleaseNotes(build, operator)).toEqual([feedback, discord])
  }
  // A prerelease of 7.122.0 has not shipped the note yet.
  expect(availableReleaseNotes('7.122.0-rc.1', operator)).toEqual([discord])
})

const hostedFeedback = {
  version: '7.122.0',
  highlights: [{
    title: 'Send feedback from your agent',
    text: 'Ask your AI agent to send feedback to the Canonry team. It replaces the Feedback button, and API keys are removed before anything is sent.',
  }],
}

it('shows each note only to readers who can act on it', () => {
  // Hosted customers have no CLI, so their note names only the agent.
  expect(availableReleaseNotes('7.122.0', { ...operator, whatsNewOnly: true })).toEqual([hostedFeedback, discord])
  // Sending feedback needs write authority.
  expect(availableReleaseNotes('7.122.0', { ...operator, canWrite: false })).toEqual([discord])
  // An operator who hid feedback (`dashboard.showFeedback: false`) gets no pointer to it.
  expect(availableReleaseNotes('7.122.0', { ...operator, showFeedback: false })).toEqual([discord])
  expect(availableReleaseNotes('7.122.0', { ...operator, showResourceLinks: false })).toEqual([feedback])
  expect(availableReleaseNotes('7.122.0', { showResourceLinks: false, whatsNewOnly: true, canWrite: false, showFeedback: true })).toEqual([])
})

it('excludes future, malformed or inapplicable release highlights', () => {
  for (const build of ['7.116.9', '7.117.0-rc.1+custom-build', '7.118.0-rc.01', '7.117.0+', 'unknown']) {
    expect(availableReleaseNotes(build)).toEqual([])
  }
  expect(availableReleaseNotes('7.118.0', { ...operator, showResourceLinks: false })).toEqual([])
})
