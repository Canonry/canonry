import { describe, expect, it } from 'vitest'
import { shouldNavigateFromRowClick } from '../src/lib/row-navigation.js'

const click = (over: Partial<Parameters<typeof shouldNavigateFromRowClick>[0]> = {}) => ({
  target: null,
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe('shouldNavigateFromRowClick', () => {
  it('navigates on a plain primary click', () => {
    expect(shouldNavigateFromRowClick(click())).toBe(true)
  })

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('leaves a %s click to the browser, so open-in-new-tab still works', (_label, mods) => {
    expect(shouldNavigateFromRowClick(click(mods))).toBe(false)
  })

  it('ignores middle and right clicks', () => {
    expect(shouldNavigateFromRowClick(click({ button: 1 }))).toBe(false)
    expect(shouldNavigateFromRowClick(click({ button: 2 }))).toBe(false)
  })

  it('ignores a click something else already handled', () => {
    expect(shouldNavigateFromRowClick(click({ defaultPrevented: true }))).toBe(false)
  })

  it.each(['a', 'button', 'input', 'select', 'textarea', 'label'])(
    'does not navigate when the click came from a <%s> inside the row', tag => {
      const row = document.createElement('tr')
      const cell = document.createElement('td')
      const control = document.createElement(tag)
      cell.appendChild(control)
      row.appendChild(cell)
      document.body.appendChild(row)
      expect(shouldNavigateFromRowClick(click({ target: control }))).toBe(false)
      row.remove()
    })

  it('does not navigate when the click came from a role=button element', () => {
    const el = document.createElement('div')
    el.setAttribute('role', 'button')
    document.body.appendChild(el)
    expect(shouldNavigateFromRowClick(click({ target: el }))).toBe(false)
    el.remove()
  })

  it('still navigates a row whose whole table sits inside a disclosure', () => {
    const disclosure = document.createElement('details')
    disclosure.open = true
    const table = document.createElement('table')
    const row = table.createTBody().insertRow()
    const cell = row.insertCell()
    cell.textContent = '116'
    disclosure.appendChild(table)
    document.body.appendChild(disclosure)
    expect(shouldNavigateFromRowClick(click({ target: cell, currentTarget: row }))).toBe(true)
    disclosure.remove()
  })

  it('navigates when the click came from plain text in a cell', () => {
    const cell = document.createElement('td')
    cell.textContent = '116'
    document.body.appendChild(cell)
    expect(shouldNavigateFromRowClick(click({ target: cell }))).toBe(true)
    cell.remove()
  })

  it('does not navigate when the drag selected text, so figures stay copyable', () => {
    const cell = document.createElement('td')
    cell.textContent = '116 content crawls'
    document.body.appendChild(cell)
    const range = document.createRange()
    range.selectNodeContents(cell)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(shouldNavigateFromRowClick(click({ target: cell }))).toBe(false)

    selection.removeAllRanges()
    // With the selection cleared, the same click is a click again.
    expect(shouldNavigateFromRowClick(click({ target: cell }))).toBe(true)
    cell.remove()
  })
})
