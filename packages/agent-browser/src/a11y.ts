// What an accessibility-tree agent sees instead of pixels: Chrome's computed accessibility
// tree as an indented outline, with a ref on every element it can act on. Actions resolve a
// ref back to its DOM node and act on it the way a person would (a real click on its box,
// typed text replacing the field's text, a chosen option firing input and change events).

import { jsonValueText } from '@canonry/canonry-contracts'
import type { BrowserSession } from './browser.js'

interface AXValue {
  value?: unknown
}

interface AXNode {
  nodeId: string
  ignored: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: Array<{ name: string; value: AXValue }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

const ACTIONABLE_ROLES = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
])

const FLATTENED_ROLES = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea'])

const STATE_PROPERTIES = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'invalid']

export interface A11ySnapshot {
  text: string
  refs: Map<string, number>
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

function str(v: AXValue | undefined): string {
  return jsonValueText(v?.value).replace(/\s+/g, ' ').trim()
}

/** Serializes the page's accessibility tree; refs map to backend DOM node ids. */
export async function takeA11ySnapshot(session: BrowserSession, maxChars = 40_000): Promise<A11ySnapshot> {
  await session.page.Accessibility.enable().catch(() => undefined)
  const { nodes } = (await session.page.Accessibility.getFullAXTree({})) as unknown as { nodes: AXNode[] }
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const root = nodes.find((n) => !n.parentId) ?? nodes[0]
  const refs = new Map<string, number>()
  const lines: string[] = []
  let length = 0
  let truncated = false

  const emit = (depth: number, line: string) => {
    if (truncated) return
    const full = `${'  '.repeat(depth)}${line}`
    if (length + full.length > maxChars) {
      truncated = true
      return
    }
    lines.push(full)
    length += full.length + 1
  }

  const walk = (node: AXNode | undefined, depth: number) => {
    if (!node || truncated) return
    const children = (node.childIds ?? []).map((id) => byId.get(id))
    const role = str(node.role)
    if (node.ignored || (FLATTENED_ROLES.has(role) && !str(node.name))) {
      for (const child of children) walk(child, depth)
      return
    }
    if (role === 'StaticText') {
      const text = str(node.name)
      if (text) emit(depth, `- text: ${clip(text, 200)}`)
      return
    }
    const name = str(node.name)
    const parts = [`- ${role || 'element'}`]
    if (name) parts.push(` "${clip(name, 120)}"`)
    const props = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]))
    const level = props.get('level')
    if (role === 'heading' && level !== undefined) parts.push(` [level=${jsonValueText(level)}]`)
    for (const key of STATE_PROPERTIES) {
      const v = props.get(key)
      if (v === true || v === 'true' || v === 'mixed') parts.push(` [${key}${v === 'mixed' ? '=mixed' : ''}]`)
    }
    const value = str(node.value)
    if (value && value !== name) parts.push(`: ${clip(value, 120)}`)
    if (ACTIONABLE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
      const ref = `e${refs.size + 1}`
      refs.set(ref, node.backendDOMNodeId)
      parts.push(` [ref=${ref}]`)
    }
    emit(depth, parts.join(''))
    for (const child of children) walk(child, depth + 1)
  }

  walk(root, 0)
  if (truncated) lines.push(`…(the snapshot stops at ${maxChars} characters)`)
  return { text: `URL: ${await session.url()}\nTitle: ${await session.title()}\n\n${lines.join('\n')}`, refs }
}

async function objectIdFor(session: BrowserSession, backendNodeId: number): Promise<string> {
  const { object } = await session.page.DOM.resolveNode({ backendNodeId })
  if (!object.objectId) throw new Error('The element is no longer on the page.')
  return object.objectId
}

/** Clicks the middle of the element, scrolling it into view first. */
export async function clickNode(session: BrowserSession, backendNodeId: number): Promise<void> {
  await session.page.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => undefined)
  const { quads } = await session.page.DOM.getContentQuads({ backendNodeId })
  const quad = quads.find((q) => q.length >= 8)
  if (!quad) throw new Error('The element is not visible, so it cannot be clicked.')
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
  await session.click(x, y)
}

/** Replaces the text in a field, as selecting everything and typing would. */
export async function fillNode(session: BrowserSession, backendNodeId: number, text: string): Promise<void> {
  await session.page.DOM.scrollIntoViewIfNeeded({ backendNodeId }).catch(() => undefined)
  await session.page.DOM.focus({ backendNodeId })
  const objectId = await objectIdFor(session, backendNodeId)
  const { result } = await session.page.Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function () {
      if (this.tagName === 'SELECT') return 'select';
      if (typeof this.select === 'function') { this.select(); return 'ok'; }
      if (this.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(this);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return 'ok';
      }
      return 'not-editable';
    }`,
    returnByValue: true,
  })
  if (result.value === 'select') throw new Error('That element is a dropdown. Use select_option instead.')
  if (result.value === 'not-editable') throw new Error('That element does not accept text.')
  if (text === '') await session.pressKeys(['Backspace'])
  else await session.page.Input.insertText({ text })
  await session.settle(200)
}

/** Chooses a dropdown option by its visible label, firing the events a framework listens for. */
export async function selectNodeOption(session: BrowserSession, backendNodeId: number, label: string): Promise<string> {
  const objectId = await objectIdFor(session, backendNodeId)
  const { result, exceptionDetails } = await session.page.Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function (label) {
      if (this.tagName !== 'SELECT') throw new Error('That element is not a dropdown.');
      const want = String(label).trim().toLowerCase();
      const options = Array.from(this.options);
      const match =
        options.find((o) => o.label.trim().toLowerCase() === want) ||
        options.find((o) => (o.textContent || '').trim().toLowerCase() === want) ||
        options.find((o) => o.value.toLowerCase() === want);
      if (!match) throw new Error('No option named "' + label + '". Options: ' + options.map((o) => o.label.trim()).join(', '));
      if (match.disabled) throw new Error('The option "' + match.label.trim() + '" is disabled.');
      for (const option of options) option.selected = option === match;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return match.label.trim();
    }`,
    arguments: [{ value: label }],
    returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text)
  await session.settle()
  return typeof result.value === 'string' ? result.value : label
}
