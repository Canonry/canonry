import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActionMenu } from '../src/components/shared/ActionMenu.js'
import { SitemapTable, type SitemapRowView } from '../src/components/project/SitemapTable.js'
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
