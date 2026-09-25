import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { noInlinePercentRule } from '../eslint-rules/no-inline-percent.js'

describe('canonry-guards/no-inline-percent', () => {
  RuleTester.describe = describe
  RuleTester.it = it
  // `RuleTester.run` declares its own suite, so it is called at describe time.
  new RuleTester({
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  }).run('no-inline-percent', noInlinePercentRule, {
    valid: [
      'const label = formatPercent(share)',
      'const line = `${formatPercent(rate, "percent")} of answers`',
      // CSS geometry: an unrounded value followed by % is layout, not text.
      'const style = { width: `${share * 100}%` }',
      // Computing a wire value without printing a percent sign.
      'const citationRate = Math.round((cited / total) * 100)',
      'const full = "100%"',
      'const count = `${total.toLocaleString()} answers`',
      '<span>{formatPercent(share)}</span>',
      // CSS geometry in markup or a style object is layout, even when rounded.
      'const bar = `<div class="fill" style="width:${pct.toFixed(1)}%;background:red"></div>`',
      'const dot = `<i style="left: ${Math.round(x * 100)}%"></i>`',
      'const style = { width: `${pct.toFixed(1)}%`, minHeight: `${Math.round(h)}%` }',
    ],
    invalid: [
      { code: 'const label = `${(share * 100).toFixed(1)}%`', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const label = `${Math.round(share * 100)}%`', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const label = `${Math.round(Number((share * 100).toFixed(6)))}% missed`', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const label = (share * 100).toFixed(1) + "%"', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const label = rate.toLocaleString() + `% of answers`', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const label = `${share === null ? "—" : (share * 100).toFixed(0)}%`', errors: [{ messageId: 'inlinePercent' }] },
      { code: '<span>{(share * 100).toFixed(0)}%</span>', errors: [{ messageId: 'inlinePercent' }] },
      { code: '<>{Math.round(rate)}% cited</>', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const label = `${new Intl.NumberFormat("en-US").format(pct)}%`', errors: [{ messageId: 'inlinePercent' }] },
      // Text next to a style is still text: only the declaration itself is exempt.
      { code: 'const row = `<div style="width:${pct.toFixed(1)}%"></div><span>${pct.toFixed(1)}%</span>`', errors: [{ messageId: 'inlinePercent' }] },
      { code: 'const meta = { label: `${Math.round(share * 100)}%` }', errors: [{ messageId: 'inlinePercent' }] },
    ],
  })
})
