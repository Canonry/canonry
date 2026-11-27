import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import { SetupTrackerList, SetupTrackerRow } from '../src/components/setup/SetupTracker.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A row whose action goes away once used (a started job), with two fields like the website form. */
function Row() {
  const [checked, setChecked] = useState(false)
  const [started, setStarted] = useState(false)
  return (
    <SetupTrackerList label="Setup progress">
      <SetupTrackerRow
        title="Website"
        mark="idle"
        action={started ? null : <button type="button" onClick={() => setStarted(true)}>Run</button>}
      >
        <input aria-label="Website URL" onBlur={() => setChecked(true)} />
        <input aria-label="Brand name" />
        {checked ? <p>Checked</p> : null}
      </SetupTrackerRow>
    </SetupTrackerList>
  )
}

test('a control that goes away while it has focus leaves focus on the row title, not the page body', () => {
  render(<Row />)
  const run = screen.getByRole('button', { name: 'Run' })
  run.focus()
  fireEvent.click(run)

  expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Website' }))
})

test('focus passing from one field to the next in a row is left alone', () => {
  render(<Row />)
  const url = screen.getByRole('textbox', { name: 'Website URL' })
  const brand = screen.getByRole('textbox', { name: 'Brand name' })
  url.focus()

  // Chrome runs React's effects between the first field's blur and the next
  // field's focus, while the page body holds focus. jsdom moves focus in one
  // step, so hold it on the body the way Chrome does while the blur re-renders.
  const held = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body)
  fireEvent.focusOut(url, { relatedTarget: brand })
  held.mockRestore()

  expect(screen.getByText('Checked')).toBeTruthy()
  // The row moved focus nowhere (not to its Run button or its title), so the
  // browser can carry on to the next field.
  expect(document.activeElement).toBe(url)
})
