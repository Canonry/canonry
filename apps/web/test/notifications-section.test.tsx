import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NOTIFICATION_EVENT_DESCRIPTIONS, notificationEventSchema } from '@canonry/canonry-contracts'

import { NotificationsSection } from '../src/components/project/NotificationsSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

const CREATED = {
  id: 'hook-1', projectId: 'p1', channel: 'webhook', url: 'https://hooks.example.com/canonry',
  urlDisplay: 'https://hooks.example.com/canonry', urlHost: 'hooks.example.com',
  events: ['mention.lost', 'mention.gained', 'citation.lost', 'citation.gained', 'review.negative'],
  enabled: true, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
}

function serve() {
  const posts: unknown[] = []
  onTestFinished(mockFetch((url, init) => {
    const path = pathOf(url).split('?')[0]!
    if (path.endsWith('/projects/acme/notifications') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return jsonResponse(CREATED, 201)
    }
    if (path.endsWith('/projects/acme/notifications')) return jsonResponse([])
    return jsonResponse({ error: { code: 'NOT_FOUND', message: path } }, 404)
  }))
  return posts
}

test('the webhook form offers every event the server accepts, with both AI visibility signals selected', async () => {
  const posts = serve()
  render(<NotificationsSection projectName="acme" />)
  fireEvent.click(await screen.findByRole('button', { name: '+ Add webhook' }))

  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes).toHaveLength(notificationEventSchema.options.length)
  // Each event's label carries the shared description, so hovering explains it.
  for (const event of notificationEventSchema.options) {
    expect(document.querySelector(`label[title="${NOTIFICATION_EVENT_DESCRIPTIONS[event]}"]`), event).not.toBeNull()
  }
  const checked = (label: string) => (screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked
  expect(boxes.filter(box => box.checked).map(box => box.closest('label')!.textContent)).toEqual([
    'Citation lost', 'Citation gained', 'Mention lost', 'Mention gained',
  ])

  fireEvent.click(screen.getByRole('checkbox', { name: 'Negative review' }))
  expect(checked('Negative review')).toBe(true)
  fireEvent.change(screen.getByPlaceholderText('https://hooks.example.com/canonry'), { target: { value: 'https://hooks.example.com/canonry' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }))

  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toEqual({ channel: 'webhook', url: 'https://hooks.example.com/canonry', events: CREATED.events })
  // The stored webhook lists its events by label.
  expect(await screen.findByText('Mention lost')).toBeTruthy()
  expect(screen.getByText('Negative review')).toBeTruthy()
})
