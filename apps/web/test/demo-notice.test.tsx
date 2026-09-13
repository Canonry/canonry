import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DemoNotice } from '../src/components/layout/DemoNotice.js'

afterEach(() => { cleanup(); delete window.__CANONRY_CONFIG__ })

function renderDemo(basePath?: string) {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true }, ...(basePath ? { basePath } : {}) }
  render(<DemoNotice />)
  return screen.getByRole('complementary', { name: 'Public demo' })
}

const AGENT_SENTENCE = 'Run it from your agent with the MCP server, API, CLI, and plugins for Claude Code and Codex.'

const EXTERNAL_LINKS: readonly [string, string][] = [
  ['canonry.ai', 'https://canonry.ai'],
  ['GitHub', 'https://github.com/Canonry/canonry'],
]

const EXAMPLE_LINKS: readonly [string, string][] = [
  ['Standard business', '/projects/summit-roofing'],
  ['Property portfolio', '/projects/harbor-resorts'],
]

const FEATURE_LINKS: readonly [string, string][] = [
  ['AI visibility', '/projects/summit-roofing'],
  ['Search engines', '/projects/summit-roofing/search-console'],
  ['Traffic & conversions', '/projects/summit-roofing/conversions'],
  ['Reports', '/projects/harbor-resorts/report'],
  ['Properties & markets', '/projects/harbor-resorts'],
  ['Queries & research', '/projects/harbor-resorts/queries'],
  ['Activity', '/projects/harbor-resorts/activity'],
  ['Site health', '/projects/summit-roofing/technical-aeo'],
  ['Local presence', '/projects/summit-roofing/local'],
  ['Backlinks', '/projects/summit-roofing/backlinks'],
]

const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')

function mediaBlock(query: string) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`@media ${escaped} \\{\\n\\s*\\.demo-banner \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ''
}

/** Declarations of a one-line rule: top level by default, or inside a media block. */
function declarations(selector: string, block?: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (block ?? css).match(new RegExp(`\\n${block ? '  ' : ''}${escaped} \\{([^}]*)\\}`))?.[1] ?? ''
}

/** Banner text with a space between text nodes, so word boundaries hold across elements. */
function spokenText(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '')
  return parts.join(' ')
}

describe('public demo notice', () => {
  it('does not alter ordinary installations', () => {
    const { container } = render(<DemoNotice />)
    expect(container.textContent).toBe('')
  })

  it('states the demo facts and how to run Canonry from an agent', () => {
    const banner = renderDemo()
    expect(within(banner).getByText('Canonry demo')).toBeTruthy()
    expect(within(banner).getByText('No sign-in. View only. Fictional data.')).toBeTruthy()
    const sentences = within(banner).getAllByText(AGENT_SENTENCE)
    expect(sentences).toHaveLength(2)
    expect(sentences[0]!.closest('details')).toBeNull()
    expect(sentences[1]!.closest('details')).not.toBeNull()
  })

  it('drops unprovable claims and offers no mutating action', () => {
    const banner = renderDemo()
    const text = spokenText(banner)
    expect(text).not.toMatch(/every feature/i)
    expect(text).not.toMatch(/\+\s*more/i)
    expect(text).not.toMatch(/your company/i)
    expect(text).not.toMatch(/\baero\b/i)
    expect(text).not.toMatch(/\d+\s+(mcp\s+)?tools?\b/i)
    expect(text).not.toMatch(/\u2014/)
    expect(within(banner).queryByRole('button', { name: /sweep|connect|publish|sign in/i })).toBeNull()
  })

  it('makes canonry.ai the one primary action and GitHub a secondary link', () => {
    const banner = renderDemo()
    const website = within(banner).getByRole('link', { name: 'canonry.ai' })
    const repository = within(banner).getByRole('link', { name: 'GitHub' })
    expect(website.classList.contains('demo-banner-primary')).toBe(true)
    expect(website.classList.contains('demo-banner-secondary')).toBe(false)
    expect(repository.classList.contains('demo-banner-secondary')).toBe(true)
    expect(repository.classList.contains('demo-banner-primary')).toBe(false)
    expect(Array.from(banner.querySelectorAll('.demo-banner-primary'))).toEqual([website])
    expect(website.compareDocumentPosition(repository) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(repository.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(declarations('.demo-banner .demo-banner-primary')).toContain('background: var(--color-accent)')
    expect(css).not.toMatch(/\.demo-banner-secondary[^{]*\{[^}]*background/)
  })

  it('opens canonry.ai and GitHub in a new tab without tracking parameters', () => {
    const banner = renderDemo()
    for (const [name, href] of EXTERNAL_LINKS) {
      const link = within(banner).getByRole('link', { name })
      expect(link.getAttribute('href')).toBe(href)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      const note = document.getElementById(link.getAttribute('aria-describedby') ?? '')
      expect(note?.textContent).toBe('Opens in a new tab')
    }
    const anchors = Array.from(banner.querySelectorAll('a'))
    const externalAnchors = anchors.filter((anchor) => /^https?:/.test(anchor.getAttribute('href') ?? ''))
    expect(externalAnchors.map((anchor) => anchor.getAttribute('href')).sort()).toEqual(EXTERNAL_LINKS.map(([, href]) => href).sort())
    for (const anchor of anchors) {
      expect(anchor.getAttribute('href')).not.toMatch(/utm_/i)
      expect(anchor.getAttribute('href')).not.toContain('?')
    }
  })

  it('keeps both examples, the feature directory and the agent sentence behind the Explore disclosure', () => {
    const banner = renderDemo()
    const summary = within(banner).getByText('Explore', { selector: 'summary' })
    const details = summary.parentElement as HTMLDetailsElement
    expect(details.tagName).toBe('DETAILS')
    expect(details.firstElementChild).toBe(summary)
    expect(details.open).toBe(false)

    const examples = within(details).getByRole('navigation', { name: 'Demo examples' })
    expect(within(examples).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual(EXAMPLE_LINKS)
    const directory = within(details).getByRole('navigation', { name: 'Demo feature directory' })
    expect(within(directory).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual(FEATURE_LINKS)
    expect(within(directory).getByRole('link', { name: 'Site health' }).getAttribute('href')).toBe('/projects/summit-roofing/technical-aeo')
    for (const link of details.querySelectorAll('a')) expect(link.hasAttribute('target')).toBe(false)
    expect(within(details).getByText(AGENT_SENTENCE)).toBeTruthy()

    fireEvent.click(summary)
    expect(details.open).toBe(true)
    fireEvent.keyDown(within(directory).getByRole('link', { name: 'Reports' }), { key: 'Escape' })
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })

  it('prefixes demo links with the public base path', () => {
    const banner = renderDemo('/demo/')
    expect(within(banner).getByRole('link', { name: 'Standard business' }).getAttribute('href')).toBe('/demo/projects/summit-roofing')
    expect(within(banner).getByRole('link', { name: 'Site health' }).getAttribute('href')).toBe('/demo/projects/summit-roofing/technical-aeo')
  })

  it('keeps the strip slim and shows the agent sentence inside Explore on small screens', () => {
    expect(declarations('.demo-banner')).toContain('min-height: 56px')
    expect(declarations('.demo-banner-panel-agent')).toContain('display: none')

    const tablet = mediaBlock('(max-width: 1023px)')
    expect(declarations('.demo-banner-panel', tablet)).toMatch(/left: 24px; right: 24px; width: auto;/)

    const mobile = mediaBlock('(max-width: 639px)')
    expect(mobile).not.toBe('')
    expect(declarations('.demo-banner-agent', mobile)).toContain('display: none')
    expect(declarations('.demo-banner-panel-agent', mobile)).toContain('display: block')
    expect(declarations('.demo-banner a, .demo-banner summary', mobile)).toContain('min-height: 44px')
  })
})
