import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EngineSitemapsDto } from '@canonry/canonry-contracts'
import { ActionMenu } from '../src/components/shared/ActionMenu.js'
import { SitemapTable, type SitemapRowView } from '../src/components/project/SitemapTable.js'
import { SitemapsCard } from '../src/components/project/SitemapsCard.js'
import { sitemapPathLabel } from '../src/components/project/GscSection.js'

afterEach(cleanup)

test('a sitemap reads by its path on the property, and by host elsewhere', () => {
  expect(sitemapPathLabel('https://example.com/sitemap.xml', 'sc-domain:example.com')).toBe('/sitemap.xml')
  // A domain property can hold sitemaps on other hosts; the host must stay visible.
  expect(sitemapPathLabel('https://blog.example.com/sitemap.xml', 'sc-domain:example.com')).toBe('blog.example.com/sitemap.xml')
  expect(sitemapPathLabel('https://example.com/news/sitemap.xml?page=2', 'https://example.com/')).toBe('/news/sitemap.xml?page=2')
  expect(sitemapPathLabel('https://example.com/news/sitemap.xml', 'https://example.com/news')).toBe('/sitemap.xml')
  expect(sitemapPathLabel('http://example.com/sitemap.xml', 'https://example.com/')).toBe('example.com/sitemap.xml')
  expect(sitemapPathLabel('not a url', null)).toBe('not a url')
})

const row = (url: string, extra: Partial<SitemapRowView> = {}): SitemapRowView => ({
  url, label: url.replace('https://example.com', ''), isIndex: false,
  status: { label: 'Success', tone: 'positive' }, urls: 3, submittedAt: '2026-10-18T09:00:00.000Z', lastReadAt: null, ...extra,
})

test('the table shows one status, the dates, the default tag and no action column without actions', () => {
  render(
    <SitemapTable
      rows={[row('https://example.com/sitemap.xml', { isDefault: true, status: { label: 'Errors', tone: 'negative', detail: '1 error' } })]}
      expanded={new Set()}
      onToggle={() => undefined}
      lastReadLabel="Last read"
      empty="None"
    />,
  )
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Sitemap', 'Status', 'URLs', 'Submitted', 'Last read'])
  expect(screen.getByText('Errors')).not.toBeNull()
  expect(screen.getByText('1 error')).not.toBeNull()
  expect(screen.getByText('Oct 18, 2026')).not.toBeNull()
  expect(screen.getByText('Not yet')).not.toBeNull()
  expect(screen.getByText('Default')).not.toBeNull()
})

test('the resubmit menu runs the chosen action, and Escape closes it back to its button', () => {
  const index = vi.fn()
  const files = vi.fn()
  render(
    <ActionMenu
      label="Resubmit all"
      menuLabel="Resubmit sitemaps"
      items={[
        { key: 'index', label: 'Resubmit sitemap index', description: 'The index only.', onSelect: index },
        { key: 'files', label: 'Resubmit all files', onSelect: files, disabled: true },
      ]}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Resubmit all' })
  fireEvent.click(trigger)
  expect(screen.getByRole('menu', { name: 'Resubmit sitemaps' })).not.toBeNull()
  expect((screen.getByRole('menuitem', { name: /^Resubmit all files/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: /^Resubmit sitemap index/ }))
  expect(index).toHaveBeenCalledOnce()
  expect(files).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
})

const coverage = (): EngineSitemapsDto => ({
  syncedAt: '2026-11-04T06:00:00.000Z',
  sitemaps: [],
  missing: [{ url: 'https://example.com/pages.xml', foundIn: ['site'] }],
})

function renderCard(onSubmit: (urls: string[]) => Promise<readonly string[]>) {
  render(
    <SitemapsCard
      engine="Google"
      data={coverage()}
      label={(url) => url.replace('https://example.com', '')}
      canSubmit
      onSubmit={onSubmit}
      submitting={false}
      notRead={<p>Never read</p>}
    />,
  )
}

test('a missing sitemap reads Sent only when the engine accepted it', async () => {
  const refused = vi.fn(async () => [] as string[])
  renderCard(refused)
  fireEvent.click(screen.getByRole('button', { name: 'Add to Google' }))
  await waitFor(() => expect(refused).toHaveBeenCalledWith(['https://example.com/pages.xml']))
  // The engine refused, so the row stays missing and can be tried again.
  expect(screen.getByText('Missing')).not.toBeNull()
  expect(screen.queryByText('Sent')).toBeNull()
  expect((screen.getByRole('button', { name: 'Add to Google' }) as HTMLButtonElement).disabled).toBe(false)
  cleanup()

  renderCard(async (urls) => urls)
  fireEvent.click(screen.getByRole('button', { name: 'Add to Google' }))
  await waitFor(() => expect(screen.getAllByText('Sent').length).toBeGreaterThan(0))
  expect(screen.queryByText('Missing')).toBeNull()
})

test('Add another keeps the URL box open when the engine refuses the sitemap', async () => {
  let accept = false
  renderCard(async (urls) => (accept ? urls : []))
  fireEvent.click(screen.getByRole('button', { name: 'Add another' }))
  fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://example.com/extra.xml' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit to Google' }))
  await waitFor(() => expect((screen.getByLabelText('Sitemap URL') as HTMLInputElement).value).toBe('https://example.com/extra.xml'))
  await Promise.resolve()
  expect(screen.queryByLabelText('Sitemap URL')).not.toBeNull()

  accept = true
  fireEvent.click(screen.getByRole('button', { name: 'Submit to Google' }))
  await waitFor(() => expect(screen.queryByLabelText('Sitemap URL')).toBeNull())
})
