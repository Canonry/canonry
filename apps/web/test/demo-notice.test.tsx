import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DemoNotice } from '../src/components/layout/DemoNotice.js'

afterEach(() => { cleanup(); delete window.__CANONRY_CONFIG__ })

describe('public demo notice', () => {
  it('does not alter ordinary installations', () => {
    const { container } = render(<DemoNotice />)
    expect(container.textContent).toBe('')
  })
  it('labels fictional data and links directly to both portfolio experiences', () => {
    window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
    render(<DemoNotice />)
    expect(screen.getByText('View-only demo with fictional sample data.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Standard business' }).getAttribute('href')).toBe('/projects/summit-roofing')
    expect(screen.getByRole('link', { name: 'Property portfolio' }).getAttribute('href')).toBe('/projects/harbor-resorts')
    expect(screen.getByRole('link', { name: 'Site health' }).getAttribute('href')).toContain('/technical-aeo')
    expect(screen.queryByRole('button', { name: /run|connect|publish/i })).toBeNull()
  })
})
