import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { AdvancedMeasurementSetupWizard } from '../src/components/project/advanced-measurement/AdvancedMeasurementSetupWizard.js'

afterEach(cleanup)

// The one sentence about the wizard sits behind the help icon beside its heading.
const INTRO = 'Choose the locations and queries you want to measure.'

describe('advanced measurement setup shell', () => {
  it('shows the five customer-facing steps in order', () => {
    render(
      <AdvancedMeasurementSetupWizard currentStep="properties" hasDraft canEdit onDiscard={vi.fn()}>
        <p>Step content</p>
      </AdvancedMeasurementSetupWizard>,
    )

    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Import',
      'Locations',
      'Groups',
      'Queries',
      'Review and publish',
    ])
    expect(screen.getByText('Locations').getAttribute('aria-current')).toBe('step')
    expect(screen.getByRole('group', { name: 'Advanced measurement setup progress' })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Advanced measurement setup progress' })).toBeNull()

    const heading = screen.getByRole('heading', { name: 'Advanced measurement setup' })
    expect(heading.parentElement?.parentElement?.className).toContain('flex-wrap')
    // No sentence under the heading: it is the help icon's name and bubble.
    expect(screen.getByRole('button', { name: INTRO })).toBeTruthy()
    expect(screen.queryByText(INTRO)).toBeNull()
    expect(document.body.textContent).not.toMatch(/propert/i)
  })

  it('moves focus to the new step heading after a step change', async () => {
    const view = render(
      <AdvancedMeasurementSetupWizard currentStep="import" hasDraft={false} canEdit>
        <section><h2>Import locations</h2><button type="button">Review sitemap</button></section>
      </AdvancedMeasurementSetupWizard>,
    )
    screen.getByRole('button', { name: 'Review sitemap' }).focus()

    view.rerender(
      <AdvancedMeasurementSetupWizard currentStep="properties" hasDraft={false} canEdit>
        <section><h2>Locations</h2><button type="button">Continue</button></section>
      </AdvancedMeasurementSetupWizard>,
    )

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Locations' })))
    expect(screen.getByRole('heading', { name: 'Locations' }).getAttribute('tabindex')).toBe('-1')
  })

  it('makes every step an accessible navigation button when step navigation is supplied', () => {
    const onStepChange = vi.fn()
    render(
      <AdvancedMeasurementSetupWizard currentStep="properties" hasDraft={false} canEdit={false} onStepChange={onStepChange}>
        <p>Read-only setup</p>
      </AdvancedMeasurementSetupWizard>,
    )

    const progress = screen.getByRole('group', { name: 'Advanced measurement setup progress' })
    expect(within(progress).getAllByRole('button')).toHaveLength(5)
    // The only button outside the steps is the help icon.
    expect(screen.getAllByRole('button')).toHaveLength(6)
    expect(screen.getByRole('button', { name: 'Locations' }).getAttribute('aria-current')).toBe('step')

    fireEvent.click(screen.getByRole('button', { name: 'Review and publish' }))
    expect(onStepChange).toHaveBeenCalledWith('review')
  })

  it('shows draft state and requires a focused explicit discard confirmation', async () => {
    const onDiscard = vi.fn()
    render(
      <AdvancedMeasurementSetupWizard currentStep="import" hasDraft canEdit onDiscard={onDiscard}>
        <p>Step content</p>
      </AdvancedMeasurementSetupWizard>,
    )

    expect(screen.getByText('Unpublished changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.getByText('Discard all unpublished changes?')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' })))
    expect(screen.getByRole('button', { name: 'Keep editing' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: 'Discard unpublished changes' }).className).toContain('min-h-11')
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Discard all unpublished changes?')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard changes' })))

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft visible but removes mutation controls for a viewer', () => {
    render(
      <AdvancedMeasurementSetupWizard currentStep="review" hasDraft canEdit={false}>
        <p>Read-only setup</p>
      </AdvancedMeasurementSetupWizard>,
    )

    expect(screen.getByText('Unpublished changes')).toBeTruthy()
    // The help icon is the only button: no step, discard or other control.
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([INTRO])
  })
})
