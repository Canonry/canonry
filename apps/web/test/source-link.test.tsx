import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SourceLink } from '../src/components/shared/SourceLink.js'

afterEach(cleanup)

test('renders a title and full destination, including path, query, and fragment', () => {
  const url = `https://hotel.example/rooms/${'ocean-view-'.repeat(20)}?arrival=2026-09-28&guests=2#availability`
  render(<SourceLink url={url} title="Hotel rooms" />)
  expect(screen.getByText('Hotel rooms')).toBeTruthy()
  const link = screen.getByRole('link', { name: url })
  expect(link.textContent).toBe(url)
  expect(link.getAttribute('href')).toBe(url)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})

test.each([undefined, '', 'https://hotel.example/rooms'])('shows a URL without a duplicate title when title is %s', title => {
  render(<SourceLink url="https://hotel.example/rooms" title={title} />)
  expect(screen.getAllByText('https://hotel.example/rooms')).toHaveLength(1)
  expect(screen.getAllByRole('link')).toHaveLength(1)
})

test.each(['javascript:alert(1)', 'data:text/html,hello', 'mailto:hotel@example.com', '/relative-source', '//hotel.example/rooms'])('keeps non-HTTP source %s readable without making it navigable', url => {
  render(<SourceLink url={url} title="Recorded source" />)
  expect(screen.getByText('Recorded source')).toBeTruthy()
  expect(screen.getByText(url)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
})

test('retains HTTP sources and mixed-case schemes', () => {
  render(<SourceLink url="HTTP://hotel.example/rooms" />)
  expect(screen.getByRole('link').getAttribute('href')).toBe('HTTP://hotel.example/rooms')
})
