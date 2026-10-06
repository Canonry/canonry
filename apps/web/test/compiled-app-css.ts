import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { compile } from 'tailwindcss'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')
const tailwindRoot = resolve(import.meta.dirname, '../node_modules/tailwindcss')

async function loadTailwindStylesheet(id: string) {
  if (id !== 'tailwindcss' && !id.startsWith('tailwindcss/')) {
    throw new Error(`Unexpected stylesheet import: ${id}`)
  }

  const filename = id === 'tailwindcss'
    ? 'index.css'
    : `${id.slice('tailwindcss/'.length)}.css`
  const path = resolve(tailwindRoot, filename)
  return {
    path,
    base: dirname(path),
    content: await readFile(path, 'utf8'),
  }
}

export async function compileAppStyles(candidates: string[]) {
  const compiler = await compile(await readFile(stylesPath, 'utf8'), {
    from: stylesPath,
    base: dirname(stylesPath),
    loadStylesheet: loadTailwindStylesheet,
  })

  return compiler.build(candidates)
}

/** Bounded parser for compiled component rules, including selector lists and at-rule context. */
export type CompiledRule = { selector: string; context: string[]; layerOrder: number; declarations: [string, string][] }
export function parseCompiledCss(input: string): CompiledRule[] {
  const css = input.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CompiledRule[] = []
  const layers = new Map<string, number>()
  const registerLayers = (names: string) => {
    for (const name of names.split(',').map(value => value.trim())) {
      if (name && !layers.has(name)) layers.set(name, layers.size)
    }
  }
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ')
  function scan(start: number, end: number, context: string[], selector?: string) {
    let token = start, quote = '', parentheses = 0
    const declarations: [string, string][] = []
    for (let index = start; index < end; index++) {
      const character = css[index]!
      if (quote) { if (character === quote && css[index - 1] !== '\\') quote = ''; continue }
      if (character === '"' || character === "'") { quote = character; continue }
      if (character === '(') parentheses++
      if (character === ')') parentheses--
      if (parentheses !== 0) continue
      if (character === ';') {
        const text = css.slice(token, index).trim(), colon = text.indexOf(':')
        if (!selector && text.startsWith('@layer ')) registerLayers(text.slice('@layer '.length))
        if (selector && colon > 0) declarations.push([text.slice(0, colon).trim(), normalize(text.slice(colon + 1))])
        token = index + 1
      } else if (character === '{') {
        const prelude = normalize(css.slice(token, index))
        if (prelude.startsWith('@layer ')) registerLayers(prelude.slice('@layer '.length))
        let depth = 1, close = index + 1, nestedQuote = ''
        for (; close < end && depth; close++) {
          const char = css[close]!
          if (nestedQuote) { if (char === nestedQuote && css[close - 1] !== '\\') nestedQuote = ''; continue }
          if (char === '"' || char === "'") nestedQuote = char
          else if (char === '{') depth++
          else if (char === '}') depth--
        }
        if (depth !== 0) throw new Error(`Unclosed compiled CSS rule: ${prelude}`)
        if (prelude.startsWith('@')) scan(index + 1, close - 1, [...context, prelude], selector)
        else scan(index + 1, close - 1, context, prelude)
        index = close - 1; token = close
      }
    }
    if (selector && declarations.length) {
      const layer = context.find(value => value.startsWith('@layer '))?.slice('@layer '.length)
      rules.push({ selector, context, layerOrder: layer === undefined ? Infinity : layers.get(layer) ?? Infinity, declarations })
    }
  }
  scan(0, css.length, [])
  return rules
}
function matchingRules(rules: CompiledRule[], selector: string, context?: string) {
  return rules.filter(rule => rule.selector.split(',').map(value => value.trim()).includes(selector)
    && (context === undefined ? !rule.context.some(value => value.startsWith('@media') || value.startsWith('@container')) : rule.context.includes(context)))
}
export function compiledDeclarations(rules: CompiledRule[], selector: string, context?: string): Record<string, string> {
  const matches = matchingRules(rules, selector, context)
  if (!matches.length) throw new Error(`Missing compiled CSS rule: ${selector} in ${context ?? 'base'}`)
  return Object.fromEntries(matches.flatMap(rule => rule.declarations))
}
export function compiledDeclarationValues(rules: CompiledRule[], selector: string, property: string, context?: string): string[] {
  return matchingRules(rules, selector, context).flatMap(rule => rule.declarations.filter(([key]) => key === property).map(([, value]) => value))
}
export function compiledElementProperty(rules: CompiledRule[], element: Element, property: string, context?: string): string | undefined {
  const selectors = new Set([...element.classList].map(candidate => `.${candidate.replace(/([^\w-])/g, '\\$1')}`))
  let value: string | undefined
  let winningLayer = -1
  for (const rule of rules) {
    const inContext = context === undefined
      ? !rule.context.some(value => value.startsWith('@media') || value.startsWith('@container'))
      : rule.context.includes(context)
    if (!inContext) continue
    if (selectors.has(rule.selector) || rule.selector.split(',').some(selector => selectors.has(selector.trim()))) {
      const candidate = rule.declarations.filter(([key]) => key === property).at(-1)?.[1]
      if (candidate !== undefined && rule.layerOrder >= winningLayer) {
        value = candidate
        winningLayer = rule.layerOrder
      }
    }
  }
  return value
}
export function resolvedCompiledProperty(rules: CompiledRule[], selector: string, property: string): string {
  const local = compiledDeclarations(rules, selector)
  const value = local[property]
  if (value === undefined) throw new Error(`Missing compiled CSS property: ${selector} ${property}`)
  // Tailwind's numeric composition uses empty fallbacks for unselected local features.
  return value.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (_match, key: string, fallback: string | undefined) =>
    local[key] ?? (key.startsWith('--tw-') ? fallback ?? '' : rules.flatMap(rule => rule.declarations).find(([name]) => name === key)?.[1] ?? fallback ?? ''),
  ).trim().replace(/\s+/g, ' ')
}
/** Resolve only the px/rem/spacing expressions emitted for this cohort, at a 16px root. */
export function cssLengthPx(value: string, rules: CompiledRule[]): number {
  const literal = value.match(/^(-?[\d.]+)(px|rem)?$/)
  if (literal) return Number(literal[1]) * (literal[2] === 'rem' ? 16 : 1)
  const calc = value.match(/^calc\(var\((--[\w-]+)\) \* (-?[\d.]+)\)$/)
  if (calc) {
    const variable = rules.flatMap(rule => rule.declarations).find(([key]) => key === calc[1])?.[1]
    if (!variable) throw new Error(`Missing compiled CSS variable: ${calc[1]}`)
    return cssLengthPx(variable, rules) * Number(calc[2])
  }
  throw new Error(`Unsupported compiled length: ${value}`)
}
