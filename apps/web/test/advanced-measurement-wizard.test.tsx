import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
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
    expect(screen.getByRole('group', { name: 'Bulk setup progress' })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Bulk setup progress' })).toBeNull()

    const heading = screen.getByRole('heading', { name: 'Bulk setup' })
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

    const progress = screen.getByRole('group', { name: 'Bulk setup progress' })
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

    expect(screen.getByText('Draft')).toBeTruthy()
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

    expect(screen.getByText('Draft')).toBeTruthy()
    // The help icon is the only button: no step, discard or other control.
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([INTRO])
  })
})

/**
 * "Property" stays in code, on the wire, in the `{property}` token and in the CSV header. Nothing a person reads in the
 * setup says it, nor "assign", "scope", "classify" or "Whole site". The rendered tests reach only the branches their
 * fixtures draw, so this reads the source of every setup file: JSX text, and each string or template fragment that is
 * copy (it has a space, or starts with a capital). A machine token (`'properties'`, `'no-query-assignments'`), a type,
 * an import and a `className` are not copy.
 */
const OLD_WORDS = /propert|assign|scope|classif|whole site/i
const NOT_COPY_ATTRIBUTES = new Set(['className', 'id', 'htmlFor', 'name', 'aria-labelledby'])
/** Where a person sees the wire name on purpose: the pattern token, and the CSV header in the example and in its hint. */
const WIRE_NAMES_SHOWN = ['{property}', 'property,group,url', 'Use columns named property and group.']

function oldWordCopy(source: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): string[] {
  const file = ts.createSourceFile('scan.tsx', source, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return
    if (ts.isJsxAttribute(node) && NOT_COPY_ATTRIBUTES.has(node.name.getText(file))) return
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    if (ts.isJsxText(node) || (literal && (/\s/.test(node.text) || /^[A-Z]/.test(node.text)))) {
      const copy = WIRE_NAMES_SHOWN.reduce((text, shown) => text.replaceAll(shown, ''), node.text)
      if (OLD_WORDS.test(copy)) found.push(node.text.trim())
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('advanced measurement setup wording', () => {
  it('reads copy out of source, and passes over machine tokens, types, class names and the shown wire names', () => {
    expect(oldWordCopy([
      'type Step = "Property scope" | "properties"',
      'const id = "no-query-assignments"; const step = "properties"; const key = `assign-${id}`',
      'const title = "Assignments"; const notice = `${count} Properties need review.`; const fallback = "Could not assign these queries."',
      'const view = <section className="property scope" aria-label="Property picker"><h2>Classify a query</h2><p>Use {"{property}"} for the Whole site, {count} times.</p></section>',
      'const hint = <p placeholder={"property,group,url\\nHarbor House,Dallas"}>Use columns named property and group. URL is optional.</p>',
    ].join('\n'))).toEqual(['Assignments', 'Properties need review.', 'Could not assign these queries.', 'Property picker', 'Classify a query', 'for the Whole site,'])
  })

  it.each([
    'AdvancedMeasurementSection.tsx',
    'AdvancedMeasurementSetupWizard.tsx',
    'SetupImportProperties.tsx',
    'SetupQueriesGroupsReview.tsx',
    'model.ts',
    'service.ts',
  ])('says location, never property, assignment, scope or classification, in the copy of %s', name => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/components/project/advanced-measurement', name), 'utf8')
    expect(oldWordCopy(source, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)).toEqual([])
  })
})
