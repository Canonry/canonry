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
  it('shows actual fictional assignments, not arbitrary percentages or a fabricated total', () => {
    const dom = openMockup('#queries/tracked')
    const { document } = dom.window
    try {
      const row = document.querySelector('#tracked-rows tr')!
      expect(row.textContent).toContain('best apartments in Metro Alpha')
      expect(row.textContent).toContain('Non-brand')
      expect(row.textContent).toContain('15 Properties')
      expect(row.textContent).not.toContain('%')
      expect([...document.querySelectorAll('thead th')].map(cell => cell.textContent)).toEqual(['Query', 'Type', 'Properties', 'Status', 'Actions'])
      const search = document.querySelector<HTMLInputElement>('#tracked-search')!
      search.value = 'Metro Golf'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      const rows = [...document.querySelectorAll('#tracked-rows tr')]
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(item => item.textContent?.includes('Metro Golf'))).toBe(true)
      search.value = 'No matching query anywhere'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(document.querySelector('#tracked-results')?.textContent).toContain('No matching queries')
    } finally { dom.window.close() }
  })

  it('edits the selected query and exact audience only after confirmation, without running a test', () => {
    const dom = openMockup('#queries/tracked')
    const { document } = dom.window
    try {
      click(document, '[data-edit-query]')
      expect(document.querySelector('#promotion-title')?.textContent).toBe('Edit query')
      const query = document.querySelector<HTMLTextAreaElement>('#promotion-query-text')!
      query.value = 'Which Metro Alpha apartments have gardens?'
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      const scope = document.querySelector<HTMLSelectElement>('#promotion-scope')!
      scope.value = 'metro-bravo'
      scope.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      expect(document.querySelector('#tracked-rows')?.textContent).not.toContain(query.value)
      click(document, '[data-promotion-next]')
      expect(document.querySelector('.review-list')?.textContent).toContain('Metro Bravo')
      expect(document.querySelector('.review-list')?.textContent).toContain('15 Properties')
      expect(document.querySelector('.review-impact')?.textContent).toContain('0 provider calls started')
      click(document, '[data-promotion-publish]')
      expect(document.querySelector('#tracked-rows')?.textContent).toContain('Which Metro Alpha apartments have gardens?')
      expect(document.querySelector('#tracked-rows')?.textContent).not.toContain('best apartments in Metro Alpha')
      expect(document.querySelector('#tracked-rows')?.textContent).toContain('Awaiting first sweep')
    } finally { dom.window.close() }
  })

  it('requires an audience for new tracking and treats repeating an assignment as no change', () => {
    const dom = openMockup('#queries/tracked')
    const { document } = dom.window
    try {
      click(document, '[data-toggle-query-composer]')
      expect(document.querySelector<HTMLButtonElement>('[data-promotion-next]')?.disabled).toBe(true)
      click(document, '[data-promotion-cancel]')
      click(document, '[data-edit-query]')
      click(document, '[data-promotion-next]')
      expect(document.querySelector('.review-impact')?.textContent).toContain('No changes')
      expect(document.querySelector<HTMLButtonElement>('[data-promotion-publish]')?.disabled).toBe(true)
    } finally { dom.window.close() }
  })

  it('will not rename over another query, and stopping tracking requires explicit confirmation', () => {
    const dom = openMockup('#queries/tracked')
    const { document } = dom.window
    try {
      click(document, '[data-edit-query]')
      const query = document.querySelector<HTMLTextAreaElement>('#promotion-query-text')!
      query.value = 'luxury apartments near Metro Alpha'
      query.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(document.querySelector('#promotion-error')?.textContent).toContain('already exists')
      expect(document.querySelector<HTMLButtonElement>('[data-promotion-next]')?.disabled).toBe(true)
      click(document, '[data-promotion-cancel]')
      click(document, '[data-edit-query]')
      click(document, '[data-stop-tracking]')
      expect(document.querySelector('#tracked-rows')?.textContent).toContain('best apartments in Metro Alpha')
      expect(document.querySelector('#promotion-title')?.textContent).toBe('Stop tracking this query?')
      click(document, '[data-promotion-publish]')
      expect(document.querySelector('#tracked-rows')?.textContent).not.toContain('best apartments in Metro Alpha')
      expect(document.querySelector('#toast')?.textContent).toBe('Tracking stopped. Saved results unchanged.')
    } finally { dom.window.close() }
  })

  it('copies one tracked query into Test without provider work', () => {
    const dom = openMockup('#queries/tracked')
    const { document } = dom.window
    try {
      click(document, '[data-test-tracked-query]')
      expect(document.querySelector<HTMLTextAreaElement>('#test-query-text')?.value).toBe('best apartments in Metro Alpha')
      expect(document.querySelector('#test-call-count')?.textContent).toBe('1 provider call')
      expect(document.querySelector('#toast')?.textContent).toBe('')
    } finally { dom.window.close() }
  })
  it('leads with the form and results, with secondary workflows closed by default', () => {
    const dom = openMockup()
    const { document } = dom.window
    try {
      expect(document.querySelector('.page-head h1')?.textContent).toBe('Test queries')
      expect(document.querySelector('.page-head p')).toBeNull()
      expect(document.querySelector('#flow-root .breadcrumb')).toBeNull()
      expect(document.querySelector('.query-notice')).toBeNull()
      expect([...document.querySelectorAll('#flow-root h2')].map(heading => heading.textContent)).toEqual(['Results'])
      expect(document.body.textContent).not.toContain('Use arbitrary prompts')
      expect(document.querySelector('label[for="test-provider"]')?.textContent).toBe('Provider')
      expect(document.querySelector('#test-isolation')?.textContent).toBe('Excluded from Pulse and trends')
      for (const selector of ['#previous-tests', '#property-spot-check']) {
        const disclosure = document.querySelector<HTMLDetailsElement>(selector)
        expect(disclosure?.tagName).toBe('DETAILS')
        expect(disclosure?.open).toBe(false)
      }
    } finally {
      dom.window.close()
    }
  })

  it('opens a saved test without changing the draft or starting provider work', () => {
    const dom = openMockup()
    const { document } = dom.window
    try {
      const textarea = document.querySelector<HTMLTextAreaElement>('#test-query-text')!
      textarea.value = 'A new draft query'
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      click(document, '[data-select-test="1"]')
      expect(document.querySelector<HTMLTextAreaElement>('#test-query-text')?.value).toBe('A new draft query')
      expect(document.querySelector('#test-result-scope')?.textContent).toBe('Gemini · No location')
      expect(document.querySelectorAll('.test-result tbody tr')).toHaveLength(5)
      expect(document.querySelector('#toast')?.textContent).toBe('')
      click(document, '[data-add-to-measurement]')
      expect(document.querySelector('.promotion-origin')?.textContent).toContain('Gemini · No location')
    } finally {
      dom.window.close()
    }
  })

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
      expect(document.querySelector('#promotion-title')?.textContent).toBe('Confirm tracking')
      expect(document.querySelector('.review-impact')?.textContent).toBe('0 provider calls started')
      expect(document.querySelector('.review-list')?.textContent).toContain('Next scheduled official run: Wednesday at 9:00 AM UTC')
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
      expect(firstTrackedRow?.textContent).toContain('15 Properties')
      expect(firstTrackedRow?.textContent).toContain('Awaiting first sweep')
      expect(firstTrackedRow?.textContent).not.toContain('%')
      expect(document.querySelector('.table-footer')?.textContent).toMatch(/Showing 20 of \d+ queries/)
      expect(document.querySelector('#toast')?.textContent).toBe(
        'Query tracked. 0 provider calls started.',
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
      expect(testCallCount?.textContent).toBe('3 provider calls')
      expect(document.getElementById('test-batch-limit')?.textContent).toBe('Max 10 in prototype')
      expect(testButton?.getAttribute('aria-describedby')).toBe('test-call-count test-isolation')
      expect(testButton?.textContent).toBe('Run 3 queries')

      expect(document.querySelector('#spot-check-scope')).toBeNull()
      expect(document.getElementById('spot-check-property')?.textContent).toContain('Property: Northstar Demo Station')
      expect(document.getElementById('spot-check-provider')?.textContent).toContain('Provider: OpenAI')
      const spotCheckCallCount = document.getElementById('spot-check-call-count')
      const spotCheckButton = document.querySelector<HTMLButtonElement>('[data-spot-check]')
      expect(spotCheckCallCount?.textContent).toContain('4 assigned queries × 1 provider = 4 provider calls.')
      expect(spotCheckButton?.getAttribute('aria-describedby')).toBe('spot-check-call-count')
      expect(spotCheckButton?.textContent).toBe('Run spot check')

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

      expect(callCount?.textContent).toBe('11 queries. Remove 1 to stay within the 10-query limit.')
      expect(runButton?.textContent).toBe('Fix test queries')
      expect(runButton?.disabled).toBe(true)

      textarea!.value = '\n  \n'
      textarea!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))

      expect(callCount?.textContent).toBe('Enter a query.')
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

      expect(callCount?.textContent).toBe('1 provider call')
      expect(runButton?.textContent).toBe('Run 1 query')
      expect(runButton?.disabled).toBe(false)

      runButton?.click()

      expect(document.querySelector('#toast')?.textContent).toBe(
        'Test saved. 1 provider call.',
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
      expect(document.querySelector('#test-result-scope')?.textContent).toBe('OpenAI · Metro Golf')
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
      expect(document.querySelector('#test-result-scope')?.textContent).toBe('OpenAI · Metro Golf')
      expect(document.querySelector('.test-result tbody tr')?.textContent).toContain('What are the best luxury apartments in Metro Golf?')
      expect(document.querySelector('.test-result tbody')?.textContent).not.toContain(draftQuery)

      click(document, '[data-run-research]')

      expect(document.querySelector('#test-result-scope')?.textContent).toBe('Gemini · No location')
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
