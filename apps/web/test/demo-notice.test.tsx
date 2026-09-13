import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DemoNotice } from '../src/components/layout/DemoNotice.js'

afterEach(() => { cleanup(); delete window.__CANONRY_CONFIG__ })

function renderDemo() {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  render(<DemoNotice />)
  return screen.getByRole('complementary', { name: 'Public demo' })
}

const EXTERNAL_LINKS: readonly [RegExp, string][] = [
  [/^View on GitHub$/, 'https://github.com/Canonry/canonry'],
  [/^canonry\.ai$/, 'https://canonry.ai'],
  [/^MCP server/, 'https://github.com/Canonry/canonry/blob/main/docs/mcp.md'],
  [/^REST API/, 'https://github.com/Canonry/canonry#self-hosting-and-api'],
  [/^CLI/, 'https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md'],
  [/^Plugins and skills/, 'https://github.com/Canonry/canonry/blob/main/docs/plugins.md'],
]

describe('public demo notice', () => {
  it('does not alter ordinary installations', () => {
    const { container } = render(<DemoNotice />)
    expect(container.textContent).toBe('')
  })

  it('labels fictional data and links directly to both examples and the feature directory', () => {
    const banner = renderDemo()
    expect(within(banner).getByText('No sign-in')).toBeTruthy()
    expect(within(banner).getByText('View only')).toBeTruthy()
    expect(within(banner).getByText('Fictional data')).toBeTruthy()
    expect(within(banner).getByRole('link', { name: 'Standard business' }).getAttribute('href')).toBe('/projects/summit-roofing')
    expect(within(banner).getByRole('link', { name: 'Property portfolio' }).getAttribute('href')).toBe('/projects/harbor-resorts')
    expect(within(banner).getByRole('link', { name: 'Site health' }).getAttribute('href')).toBe('/projects/summit-roofing/technical-aeo')
  })

  it('drops the unprovable feature claim and offers no mutating action', () => {
    const banner = renderDemo()
    expect(banner.textContent).not.toMatch(/every feature/i)
    expect(banner.textContent).not.toMatch(/your company/i)
    expect(banner.textContent).not.toMatch(/\u2014/)
    expect(within(banner).queryByRole('button', { name: /sweep|connect|publish|sign in/i })).toBeNull()
  })

  it('links each agent capability, GitHub and canonry.ai to verified pages in a new tab', () => {
    const banner = renderDemo()
    expect(within(banner).getByRole('region', { name: 'Explore Canonry' })).toBeTruthy()
    expect(within(banner).getByRole('region', { name: 'Run it with your own agent' })).toBeTruthy()
    for (const [name, href] of EXTERNAL_LINKS) {
      const link = within(banner).getByRole('link', { name })
      expect(link.getAttribute('href')).toBe(href)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      const note = document.getElementById(link.getAttribute('aria-describedby') ?? '')
      expect(note?.textContent).toBe('Opens in a new tab')
    }
    const externalAnchors = Array.from(banner.querySelectorAll('a')).filter((anchor) => /^https?:/.test(anchor.getAttribute('href') ?? ''))
    expect(externalAnchors.map((anchor) => anchor.getAttribute('href')).sort()).toEqual(EXTERNAL_LINKS.map(([, href]) => href).sort())
    for (const anchor of externalAnchors) expect(anchor.getAttribute('href')).not.toMatch(/utm_/i)
  })

  it('collapses the agent tools behind a disclosure on small screens', () => {
    const banner = renderDemo()
    const toggle = within(banner).getByRole('button', { name: 'Run it with your own agent' })
    const tools = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(tools).not.toBeNull()
    expect(within(tools!).getAllByRole('link')).toHaveLength(4)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(tools!.getAttribute('data-open')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(tools!.getAttribute('data-open')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(tools!.getAttribute('data-open')).toBe('false')

    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
    const mobile = css.match(/@media \(max-width: 639px\) \{\n\s*\.demo-banner \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(mobile).toContain(".demo-banner-tools[data-open='false'] { display: none; }")
    expect(mobile).toMatch(/\.demo-banner-agent-toggle-heading \{ display: block;/)
    expect(css).toMatch(/\.demo-banner-agent-toggle-heading \{ display: none; \}/)
  })
})
