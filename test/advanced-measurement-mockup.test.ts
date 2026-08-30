import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const mockupPath = resolve(import.meta.dirname, '../docs/mockups/advanced-measurement/portfolio-scale-flows.html')
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string, options: {
    url: string
    runScripts: 'dangerously'
    beforeParse: (window: Window) => void
  }) => { window: Window }
}

function openMockup() {
  return new JSDOM(readFileSync(mockupPath, 'utf8'), {
    url: 'https://mockup.test/#queries/test',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.scrollTo = () => undefined
    },
  })
}

function click(document: Document, selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  element.click()
}

describe('advanced measurement query mockup', () => {
  it('keeps Test evidence in context and clears an uncommitted promotion when the workspace changes', () => {
    const dom = openMockup()
    const { document, location } = dom.window

    try {
      click(document, '[data-add-to-measurement]')

      expect(location.hash).toBe('#queries/test')
      expect(document.querySelector('.page-head h1')?.textContent).toBe('Test queries')
      expect(document.querySelector('#test-results-title')).not.toBeNull()
      expect(document.querySelector('.promotion-panel')).not.toBeNull()

      click(document, '[data-promotion-next]')
      expect(document.querySelector('.promotion-body h3')?.textContent).toBe('Confirm measurement change')
      expect(document.activeElement?.id).toBe('promotion-title')
      expect(document.querySelector('[data-query-view="test"]')?.getAttribute('aria-current')).toBe('page')

      click(document, '[data-query-view="test"]')
      expect(location.hash).toBe('#queries/test')
      expect(document.querySelector('#test-results-title')).not.toBeNull()
      expect(document.querySelector('.promotion-panel')).toBeNull()

      click(document, '[data-query-view="tracked"]')

      expect(location.hash).toBe('#queries/tracked')
      expect(document.querySelector('.page-head h1')?.textContent).toBe('Tracked queries')
      expect(document.querySelector('caption')?.textContent).toBe('Tracked project queries')
      expect(document.querySelector('.promotion-panel')).toBeNull()
      expect(document.querySelector('[data-query-view="tracked"]')?.getAttribute('aria-current')).toBe('page')
      expect(document.activeElement).toBe(document.querySelector('[data-query-view="tracked"]'))
    } finally {
      dom.window.close()
    }
  })

  it('publishes directly to the visible tracked table with an awaiting-first-sweep row', () => {
    const dom = openMockup()
    const { document, location } = dom.window

    try {
      click(document, '[data-add-to-measurement]')
      click(document, '[data-promotion-next]')
      click(document, '[data-promotion-publish]')

      const firstTrackedRow = document.querySelector('tbody tr')
      const expectedQuery = 'What are the best luxury apartments in Metro Golf?'

      expect(location.hash).toBe('#queries/tracked')
      expect(document.querySelector('.page-head h1')?.textContent).toBe('Tracked queries')
      expect(document.querySelector('.promotion-panel')).toBeNull()
      expect(firstTrackedRow?.textContent).toContain(expectedQuery)
      expect(firstTrackedRow?.textContent).toContain('15 of 225')
      expect(firstTrackedRow?.textContent).toContain('Awaiting first sweep')
      expect(firstTrackedRow?.textContent?.match(/Not measured/g)).toHaveLength(2)
      expect(document.querySelector('.table-footer')?.textContent).toContain('Showing 12 of 37 tracked queries')
      expect(document.activeElement).toBe(document.querySelector('[data-query-view="tracked"]'))
    } finally {
      dom.window.close()
    }
  })
})
