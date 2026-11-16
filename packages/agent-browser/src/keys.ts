// Key names as agents send them, mapped to the Chrome DevTools Protocol key events a real
// US keyboard produces. Agents use several spellings for the same key: xdotool names from
// Claude ("Return", "Page_Down"), upper-case names from OpenAI ("ENTER", "ARROWDOWN") and
// DOM names from Gemini ("Enter", "Control").

export interface KeyDefinition {
  key: string
  code: string
  keyCode: number
  /** Text the key inserts when pressed without Control, Alt or Meta. */
  text?: string
  location?: number
}

const ALIASES: Record<string, string> = {
  return: 'Enter',
  enter: 'Enter',
  kp_enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  back_space: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: ' ',
  spacebar: ' ',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  page_up: 'PageUp',
  pageup: 'PageUp',
  prior: 'PageUp',
  page_down: 'PageDown',
  pagedown: 'PageDown',
  next: 'PageDown',
  home: 'Home',
  end: 'End',
  insert: 'Insert',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
}

const SPECIAL: Partial<Record<string, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

// Base key for each printable character on a US layout: [code, keyCode].
const PRINTABLE: Partial<Record<string, [string, number]>> = {
  '-': ['Minus', 189], '_': ['Minus', 189],
  '=': ['Equal', 187], '+': ['Equal', 187],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221],
  '\\': ['Backslash', 220], '|': ['Backslash', 220],
  ';': ['Semicolon', 186], ':': ['Semicolon', 186],
  "'": ['Quote', 222], '"': ['Quote', 222],
  ',': ['Comma', 188], '<': ['Comma', 188],
  '.': ['Period', 190], '>': ['Period', 190],
  '/': ['Slash', 191], '?': ['Slash', 191],
  '`': ['Backquote', 192], '~': ['Backquote', 192],
  '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], '$': ['Digit4', 52], '%': ['Digit5', 53],
  '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
}

export const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

/** The canonical DOM name for a key as an agent spelled it, e.g. "PAGE_DOWN" → "PageDown". */
export function normalizeKeyName(raw: string): string {
  if (raw === ' ') return ' '
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const alias = ALIASES[trimmed.toLowerCase()]
  if (alias) return alias
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase()
  if (trimmed.length === 1) return trimmed
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

/** Splits "ctrl+shift+a" into ["ctrl", "shift", "a"]. A lone "+" is the plus key. */
export function splitKeyCombo(combo: string): string[] {
  const value = combo.trim()
  if (value === '+') return ['+']
  return value.split('+').map((part) => part.trim()).filter(Boolean)
}

export function keyDefinition(name: string): KeyDefinition | null {
  const key = normalizeKeyName(name)
  const special = SPECIAL[key]
  if (special) return special
  const fn = /^F([1-9]|1[0-2])$/.exec(key)
  if (fn) return { key, code: key, keyCode: 111 + Number(fn[1]) }
  if (key.length !== 1) return null
  if (/[a-z]/.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key }
  if (/[A-Z]/.test(key)) return { key, code: `Key${key}`, keyCode: key.charCodeAt(0), text: key }
  if (/\d/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key }
  const printable = PRINTABLE[key]
  if (printable) return { key, code: printable[0], keyCode: printable[1], text: key }
  return null
}

/** True when the keys, pressed together, are a shortcut the browser itself handles. */
export function comboSignature(keys: string[]): string {
  return keys.map((k) => normalizeKeyName(k).toLowerCase()).join('+')
}
