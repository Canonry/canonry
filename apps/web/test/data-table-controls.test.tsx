import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { compileAppStyles, compiledElementProperty, cssLengthPx, parseCompiledCss } from './compiled-app-css.js'
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

  test('offers no page-size choice unless the caller asks for one', () => {
    render(<DataTablePagination page={2} visibleRows={25} totalRows={932} itemLabel="queries" onPageChange={() => undefined} />)

    expect(screen.getByText('26 to 50 of 932 queries')).not.toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('Rows')).toBeNull()
  })

  test('a Rows select reports the chosen page size as a number', () => {
    const onPageSizeChange = vi.fn()
    const { rerender } = render(
      <DataTablePagination page={1} pageSize={25} visibleRows={25} totalRows={932} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} onPageSizeChange={onPageSizeChange} />,
    )

    const rows = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Rows' })
    expect([rows.value, [...rows.options].map(option => option.textContent)]).toEqual(['25', ['25', '50', '100']])
    fireEvent.change(rows, { target: { value: '100' } })
    expect(onPageSizeChange).toHaveBeenCalledWith(100)

    // One page of rows has no Previous or Next, and can still be made shorter.
    rerender(<DataTablePagination page={1} pageSize={50} visibleRows={12} totalRows={12} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} onPageSizeChange={onPageSizeChange} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Rows' }).value).toBe('50')
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()

    // A page size that is not one of the choices still shows as the current one, in order.
    rerender(<DataTablePagination page={1} pageSize={40} visibleRows={40} totalRows={932} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} onPageSizeChange={onPageSizeChange} />)
    const odd = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Rows' })
    expect([odd.value, [...odd.options].map(option => option.textContent)]).toEqual(['40', ['25', '40', '50', '100']])
  })

  test('the Rows select needs its handler, and is off while the table is busy', () => {
    const { rerender } = render(<DataTablePagination page={1} visibleRows={25} totalRows={932} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} />)
    // Choices with nothing to tell: no select that would do nothing.
    expect(screen.queryByRole('combobox')).toBeNull()

    rerender(<DataTablePagination page={2} visibleRows={25} totalRows={932} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} onPageSizeChange={() => undefined} disabled />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Rows' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(true)
    rerender(<DataTablePagination page={2} visibleRows={25} totalRows={932} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} onPageSizeChange={() => undefined} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Rows' }).disabled).toBe(false)
  })

  test('with the Rows select every control of the row is drawn alike and is a 44px target under a finger; other callers keep their buttons', async () => {
    const TOUCH = ['@media (pointer: coarse)', '@media (width < 48rem)']
    const pager = () => [screen.getByRole('button', { name: 'Previous' }), screen.getByRole('button', { name: 'Next' })]
    const rulesFor = async (container: HTMLElement) => parseCompiledCss(await compileAppStyles([...container.querySelectorAll('*')].flatMap(element => [...element.classList])))
    const touchHeights = (rules: Awaited<ReturnType<typeof rulesFor>>, control: Element) => TOUCH.map(context => {
      const height = compiledElementProperty(rules, control, 'min-height', context)
      return height === undefined ? undefined : cssLengthPx(height, rules)
    })

    const { container, rerender } = render(<DataTablePagination page={2} visibleRows={25} totalRows={932} onPageChange={() => undefined} pageSizeOptions={[25, 50, 100]} onPageSizeChange={() => undefined} />)
    const rules = await rulesFor(container)
    const rows = screen.getByRole('combobox', { name: 'Rows' })
    for (const control of [rows, ...pager()]) expect(touchHeights(rules, control), control.textContent!).toEqual([44, 44])
    // The select is as tall as the buttons beside it: the same padding around the same line, with the browser's own box and arrow off.
    expect([rows, ...pager()].map(control => cssLengthPx(compiledElementProperty(rules, control, 'padding-block')!, rules))).toEqual([6, 6, 6])
    expect(compiledElementProperty(rules, rows, 'appearance')).toBe('none')
    // A drawn chevron stands in for the arrow, and a click on it still reaches the select.
    const chevron = rows.parentElement!.querySelector('svg')!
    expect([chevron.getAttribute('aria-hidden'), compiledElementProperty(rules, chevron, 'pointer-events'), compiledElementProperty(rules, chevron, 'position')]).toEqual(['true', 'none', 'absolute'])
    // Keyboard focus shows on the select itself.
    expect(rows.className).toContain('focus-visible:ring-1')

    rerender(<DataTablePagination page={2} visibleRows={25} totalRows={932} onPageChange={() => undefined} />)
    const plain = await rulesFor(container)
    for (const control of pager()) expect(touchHeights(plain, control), control.textContent!).toEqual([undefined, undefined])
  })
})

describe('DataTableSearch size', () => {
  const heights = async (input: HTMLElement) => {
    const rules = parseCompiledCss(await compileAppStyles([...input.classList]))
    return [undefined, '@media (pointer: coarse)', '@media (width < 48rem)'].map(context => {
      const height = compiledElementProperty(rules, input, 'height', context)
      return height === undefined ? undefined : cssLengthPx(height, rules)
    })
  }

  test('the default stays 36px everywhere, and sm is 32px with a 44px target under a finger', async () => {
    const { rerender } = render(<DataTableSearch value="" onChange={() => undefined} label="Filter URLs" />)
    expect(await heights(screen.getByRole('searchbox'))).toEqual([36, undefined, undefined])

    rerender(<DataTableSearch value="" onChange={() => undefined} label="Filter URLs" size="sm" />)
    expect(await heights(screen.getByRole('searchbox'))).toEqual([32, 44, 44])
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
