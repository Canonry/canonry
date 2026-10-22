import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SegmentedRadioGroup, type SegmentedRadioOption } from '../src/components/shared/SegmentedRadioGroup.js'

afterEach(cleanup)

type Subject = 'market' | 'location' | 'company'

function renderGroup(options: readonly SegmentedRadioOption<Subject>[], initial: Subject) {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState<Subject>(initial)
    return <SegmentedRadioGroup label="Subject" options={options} value={value} onChange={next => { onChange(next); setValue(next) }} />
  }
  render(<Harness />)
  const radio = (name: string) => screen.getByRole('radio', { name })
  return { onChange, radio, group: screen.getByRole('radiogroup', { name: 'Subject' }) }
}

describe('a disabled option', () => {
  const options: SegmentedRadioOption<Subject>[] = [
    { value: 'market', label: 'Market' },
    { value: 'location', label: 'Location', disabled: true, description: 'Not available yet' },
    { value: 'company', label: 'Company' },
  ]

  it('is announced as disabled and cannot be chosen by click', () => {
    const { onChange, radio } = renderGroup(options, 'market')
    expect(radio('Location').getAttribute('aria-disabled')).toBe('true')
    expect(radio('Location').getAttribute('aria-checked')).toBe('false')
    expect(radio('Market').hasAttribute('aria-disabled')).toBe(false)
    expect(radio('Company').hasAttribute('aria-disabled')).toBe(false)
    // Still described, so assistive tech can say why it is unavailable.
    expect(document.getElementById(radio('Location').getAttribute('aria-describedby')!)!.textContent).toBe('Not available yet')

    fireEvent.click(radio('Location'))
    expect(onChange).not.toHaveBeenCalled()
    expect(radio('Market').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(radio('Company'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('company')
  })

  it('shows its description on hover, which an option that can be chosen does not', () => {
    const { radio } = renderGroup([{ ...options[0]!, description: 'One market' }, options[1]!, options[2]!], 'market')
    expect(radio('Location').title).toBe('Not available yet')
    expect(document.getElementById(radio('Market').getAttribute('aria-describedby')!)!.textContent).toBe('One market')
    expect(radio('Market').hasAttribute('title')).toBe(false)
  })

  it('is skipped by the arrow keys in both directions, moving focus with the choice', () => {
    const { onChange, radio, group } = renderGroup(options, 'market')
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('company')
    expect(radio('Company').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(radio('Company'))

    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('market')
    expect(document.activeElement).toBe(radio('Market'))

    // Wrapping passes over it too.
    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('company')
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('market')
    expect(onChange.mock.calls.flat()).not.toContain('location')
  })

  it('is passed over by Home and End when it sits at either edge', () => {
    const first = renderGroup([{ ...options[1]!, value: 'market', label: 'Market' }, { value: 'location', label: 'Location' }, options[2]!], 'company')
    fireEvent.keyDown(first.group, { key: 'Home' })
    expect(first.onChange).toHaveBeenLastCalledWith('location')
    expect(document.activeElement).toBe(first.radio('Location'))
    cleanup()

    const last = renderGroup([options[0]!, { value: 'location', label: 'Location' }, { ...options[2]!, disabled: true }], 'market')
    fireEvent.keyDown(last.group, { key: 'End' })
    expect(last.onChange).toHaveBeenLastCalledWith('location')
    expect(document.activeElement).toBe(last.radio('Location'))
  })

  it('leaves the keys alone when no option can be chosen', () => {
    const { onChange, group } = renderGroup(options.map(option => ({ ...option, disabled: true })), 'market')
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) fireEvent.keyDown(group, { key })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('a group with every option enabled', () => {
  const options: SegmentedRadioOption<Subject>[] = [
    { value: 'market', label: 'Market' },
    { value: 'location', label: 'Location' },
    { value: 'company', label: 'Company' },
  ]

  it('steps one option at a time, wraps, and jumps with Home and End', () => {
    const { onChange, radio, group } = renderGroup(options, 'market')
    for (const [key, expected] of [['ArrowRight', 'location'], ['ArrowRight', 'company'], ['ArrowRight', 'market'], ['ArrowLeft', 'company'], ['Home', 'market'], ['End', 'company']] as const) {
      fireEvent.keyDown(group, { key })
      expect(onChange).toHaveBeenLastCalledWith(expected)
    }
    expect(options.map(option => radio(option.label).hasAttribute('aria-disabled'))).toEqual([false, false, false])
    expect(options.map(option => radio(option.label).tabIndex)).toEqual([-1, -1, 0])
  })
})
