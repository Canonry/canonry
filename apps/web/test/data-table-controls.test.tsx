import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  DataTablePagination,
  DataTableSearch,
  MiddleTruncatedText,
  truncateMiddleText,
  urlSearchText,
  useClientTable,
} from '../src/components/shared/DataTableControls.js'

afterEach(() => {
  cleanup()
})

describe('truncateMiddleText', () => {
  test('preserves the boundary and truncates by Unicode code point', () => {
    expect(truncateMiddleText('1234567', 3, 3)).toBe('1234567')
    expect(truncateMiddleText('12345678', 3, 3)).toBe('123…678')
    expect(truncateMiddleText('ab😀cd😀ef', 3, 3)).toBe('ab😀…😀ef')
  })
})

describe('urlSearchText', () => {
  test('keeps malformed URLs searchable and exposes decoded parameters', () => {
    const malformed = '/audit?utm_source=%E0%A4%A&campaign=summer+launch'
    const searchable = urlSearchText(malformed)

    expect(searchable).toContain(malformed)
    expect(searchable).toContain('campaign summer launch')
    expect(urlSearchText('/audit?utm_content=footer%20link')).toContain('utm_content footer link')
  })
})

describe('useClientTable', () => {
  const searchText = (row: { label: string }) => row.label

  test('uses token-AND matching, resets on search, and clamps a shrinking page', () => {
    const initialRows = Array.from({ length: 7 }, (_, index) => ({
      label: index === 6 ? 'Alpha final two' : `Alpha row ${index}`,
    }))
    const { result, rerender } = renderHook(
      ({ rows }) => useClientTable({ rows, getSearchText: searchText, pageSize: 2 }),
      { initialProps: { rows: initialRows } },
    )

    act(() => result.current.setPage(4))
    expect(result.current.page).toBe(4)
    expect(result.current.rows).toEqual([{ label: 'Alpha final two' }])

    act(() => result.current.setQuery('alpha two'))
    expect(result.current.page).toBe(1)
    expect(result.current.rows).toEqual([{ label: 'Alpha final two' }])

    act(() => result.current.setQuery(''))
    act(() => result.current.setPage(4))
    rerender({ rows: initialRows.slice(0, 3) })
    expect(result.current.page).toBe(2)
    expect(result.current.rows).toEqual([{ label: 'Alpha row 2' }])
  })
})

describe('DataTablePagination', () => {
  test('renders the server-mode suffix and hides controls for a single page', () => {
    const onPageChange = vi.fn()
    const { rerender } = render(
      <DataTablePagination
        page={1}
        visibleRows={25}
        hasNextPage
        onPageChange={onPageChange}
      />,
    )

    expect(screen.getByText('1 to 25+ rows')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onPageChange).toHaveBeenCalledWith(2)

    rerender(
      <DataTablePagination
        page={1}
        visibleRows={1}
        totalRows={1}
        onPageChange={onPageChange}
      />,
    )
    expect(screen.getByText('1 to 1 of 1 rows')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull()
  })
})

test('DataTableSearch suppresses the native WebKit clear control', () => {
  render(<DataTableSearch value="summer" onChange={() => undefined} label="Filter URLs" />)

  expect(screen.getByRole('searchbox').className).toContain(
    '[&::-webkit-search-cancel-button]:appearance-none',
  )
})

test('MiddleTruncatedText exposes full text accessibly and accepts a custom tooltip', () => {
  const value = 'https://example.com/a/very/long/path'
  render(<MiddleTruncatedText value={value} headLength={8} tailLength={4} title="Crawl failed" />)

  const visible = screen.getByText('https://…path')
  expect(visible.getAttribute('aria-hidden')).toBe('true')
  expect(visible.parentElement?.getAttribute('title')).toBe('Crawl failed')
  expect(visible.parentElement?.querySelector('.sr-only')?.textContent).toBe(value)
})
