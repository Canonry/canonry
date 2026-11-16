import { describe, expect, it } from 'vitest'
import { keyDefinition, normalizeKeyName, splitKeyCombo } from '../src/index.js'

describe('key names as agents send them', () => {
  // Claude sends xdotool names, OpenAI upper-case names, Gemini DOM names.
  it.each([
    ['Return', 'Enter'],
    ['ENTER', 'Enter'],
    ['kp_enter', 'Enter'],
    ['Page_Down', 'PageDown'],
    ['ARROWDOWN', 'ArrowDown'],
    ['Down', 'ArrowDown'],
    ['ctrl', 'Control'],
    ['CTRL', 'Control'],
    ['super', 'Meta'],
    ['esc', 'Escape'],
    ['f5', 'F5'],
    ['a', 'a'],
    ['A', 'A'],
    [' ', ' '],
    ['', ''],
  ])('%j is the DOM key %j', (raw, want) => {
    expect(normalizeKeyName(raw)).toBe(want)
  })

  it('types a space as a key that inserts a space', () => {
    // A trimmed space became an empty name, and typing "Jordan Lee" threw.
    expect(keyDefinition(' ')).toEqual({ key: ' ', code: 'Space', keyCode: 32, text: ' ' })
  })

  it('maps characters and named keys to the codes a US keyboard sends', () => {
    expect(keyDefinition('@')).toEqual({ key: '@', code: 'Digit2', keyCode: 50, text: '@' })
    expect(keyDefinition('Q')).toEqual({ key: 'Q', code: 'KeyQ', keyCode: 81, text: 'Q' })
    expect(keyDefinition('Tab')).toEqual({ key: 'Tab', code: 'Tab', keyCode: 9 })
    expect(keyDefinition('F12')).toEqual({ key: 'F12', code: 'F12', keyCode: 123 })
    expect(keyDefinition('ctrl')).toEqual({ key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 })
    expect(keyDefinition('Hyper')).toBeNull()
  })

  it('splits a combination, keeping a lone plus as the plus key', () => {
    expect(splitKeyCombo('ctrl+shift+a')).toEqual(['ctrl', 'shift', 'a'])
    expect(splitKeyCombo(' Return ')).toEqual(['Return'])
    expect(splitKeyCombo('+')).toEqual(['+'])
  })
})
