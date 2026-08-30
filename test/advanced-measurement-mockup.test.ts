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
  }) => { window: Window & { Event: typeof Event } }
}

function openMockup(hash = '#queries/test') {
  return new JSDOM(readFileSync(mockupPath, 'utf8'), {
    url: `https://mockup.test/${hash}`,
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
      expect(document.querySelector('#toast')?.textContent).toBe(
        'Published new revision. 0 provider calls started. It will wait for the next scheduled official run.',
      )
      expect(document.activeElement).toBe(document.querySelector('[data-query-view="tracked"]'))
    } finally {
      dom.window.close()
    }
  })

  it('keeps official measurement scheduled and makes every diagnostic probe explicitly bounded', () => {
    const source = readFileSync(mockupPath, 'utf8')
    const dom = openMockup()
    const { document } = dom.window

    try {
      expect(source).not.toContain('data-run-sweep')
      expect(source).not.toContain('target.dataset.runSweep')
      expect(source).not.toContain('Run a full AI sweep')

      const scheduledRun = document.querySelector<HTMLButtonElement>('[data-project-section="settings"]')
      expect(scheduledRun?.getAttribute('aria-label')).toBe('Manage scheduled official run')
      expect(scheduledRun?.textContent).toContain('Next scheduled official run')

      const testCallCount = document.getElementById('test-call-count')
      const testButton = document.querySelector<HTMLButtonElement>('[data-run-research]')
      expect(testCallCount?.textContent).toContain('3 queries × 1 provider = 3 provider calls.')
      expect(document.getElementById('test-batch-limit')?.textContent).toContain('Prototype limit: 10 queries.')
      expect(testButton?.getAttribute('aria-describedby')).toBe('test-call-count')
      expect(testButton?.textContent).toBe('Run 3 test queries')

      expect(document.querySelector('#spot-check-scope')).toBeNull()
      expect(document.getElementById('spot-check-property')?.textContent).toContain('Property: Northstar Demo Station')
      expect(document.getElementById('spot-check-provider')?.textContent).toContain('Provider: OpenAI')
      const spotCheckCallCount = document.getElementById('spot-check-call-count')
      const spotCheckButton = document.querySelector<HTMLButtonElement>('[data-spot-check]')
      expect(spotCheckCallCount?.textContent).toContain('4 assigned queries × 1 provider = 4 provider calls.')
      expect(spotCheckButton?.getAttribute('aria-describedby')).toBe('spot-check-call-count')
      expect(spotCheckButton?.textContent).toBe('Run bounded spot check')

      spotCheckButton?.click()
      expect(document.querySelector('#toast')?.textContent).toBe(
        'Probe queued for Northstar Demo Station, 4 provider calls. Excluded from Portfolio Pulse and trends.',
      )
    } finally {
      dom.window.close()
    }
  })

  it('rejects empty and over-limit test batches without omitting queries', () => {
    const dom = openMockup()
    const { document } = dom.window

    try {
      const textarea = document.querySelector<HTMLTextAreaElement>('#test-query-text')
      const callCount = document.getElementById('test-call-count')
      const runButton = document.querySelector<HTMLButtonElement>('[data-run-research]')
      expect(textarea).toBeTruthy()

      textarea!.value = Array.from({ length: 11 }, (_, index) => `Test query ${index + 1}`).join('\n')
      textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      expect(callCount?.textContent).toBe('11 queries exceed the 10-query test limit. Remove 1 query to continue.')
      expect(runButton?.textContent).toBe('Fix test queries')
      expect(runButton?.disabled).toBe(true)

      textarea!.value = '\n  \n'
      textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      expect(callCount?.textContent).toBe('Add at least one nonempty query before running a test.')
      expect(runButton?.textContent).toBe('Add test query')
      expect(runButton?.disabled).toBe(true)
    } finally {
      dom.window.close()
    }
  })

  it('shows an exact singular preflight and saves one bounded test probe', () => {
    const dom = openMockup()
    const { document } = dom.window

    try {
      const textarea = document.querySelector<HTMLTextAreaElement>('#test-query-text')
      const callCount = document.getElementById('test-call-count')
      const runButton = document.querySelector<HTMLButtonElement>('[data-run-research]')
      expect(textarea).toBeTruthy()

      textarea!.value = 'Which apartments have a rooftop garden?'
      textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      expect(callCount?.textContent).toBe('1 query × 1 provider = 1 provider call.')
      expect(runButton?.textContent).toBe('Run 1 test query')
      expect(runButton?.disabled).toBe(false)

      runButton?.click()

      expect(document.querySelector('#toast')?.textContent).toBe(
        'Test probe complete, 1 provider call. Saved separately from official measurement.',
      )
    } finally {
      dom.window.close()
    }
  })

  it('keeps saved test evidence stable while draft provider and location change, then snapshots the new test on run', () => {
    const dom = openMockup()
    const { document } = dom.window

    try {
      const draftQuery = 'Which apartments have a quiet workspace?'
      const textarea = document.querySelector<HTMLTextAreaElement>('#test-query-text')
      expect(document.querySelector('.test-result .section-head p')?.textContent).toBe('OpenAI · Metro Golf · saved test')
      expect(textarea).toBeTruthy()

      textarea!.value = draftQuery
      textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      const provider = document.querySelector<HTMLSelectElement>('#test-provider')
      provider!.value = 'Gemini'
      provider!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))

      const location = document.querySelector<HTMLSelectElement>('#test-location')
      location!.value = 'No location'
      location!.dispatchEvent(new dom.window.Event('change', { bubbles: true }))

      expect(document.querySelector<HTMLSelectElement>('#test-provider')?.value).toBe('Gemini')
      expect(document.querySelector<HTMLSelectElement>('#test-location')?.value).toBe('No location')
      expect(document.querySelector('.test-result .section-head p')?.textContent).toBe('OpenAI · Metro Golf · saved test')
      expect(document.querySelector('.test-result tbody tr')?.textContent).toContain('What are the best luxury apartments in Metro Golf?')
      expect(document.querySelector('.test-result tbody')?.textContent).not.toContain(draftQuery)

      click(document, '[data-run-research]')

      expect(document.querySelector('.test-result .section-head p')?.textContent).toBe('Gemini · No location · saved test')
      expect(document.querySelector('.test-result tbody tr')?.textContent).toContain(draftQuery)

      click(document, '[data-add-to-measurement]')

      expect(document.querySelector('.promotion-origin')?.textContent).toContain('Gemini · No location · saved test')
    } finally {
      dom.window.close()
    }
  })

  it.each([
    ['Group', '#pulse/group/metro-alpha', 'Metro Alpha', 'Group · 15 Properties'],
    ['Property', '#pulse/property/property-1', 'Northstar Demo Arden', 'Property · Metro Alpha · 1 URL'],
  ])('opens Test queries instead of queuing a %s spot check', (_scope, hash, title, context) => {
    const source = readFileSync(mockupPath, 'utf8')
    const dom = openMockup(hash)
    const { document, location } = dom.window

    try {
      expect(document.querySelector('.page-head h1')?.textContent).toBe(title)
      expect(document.querySelector('.page-head p')?.textContent).toBe(context)
      expect(source).not.toContain(`data-spot-check="${_scope}"`)
      expect(document.querySelector(`[data-spot-check="${_scope}"]`)).toBeNull()
      const testQueries = document.querySelector<HTMLButtonElement>('[data-open-query-view="test"]')
      expect(testQueries?.textContent).toBe('Test queries')

      testQueries?.click()

      expect(location.hash).toBe('#queries/test')
      expect(document.querySelector('.page-head h1')?.textContent).toBe('Test queries')
      expect(document.querySelector('#toast')?.textContent).toBe('')
    } finally {
      dom.window.close()
    }
  })
})
