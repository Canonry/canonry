// Percent display ratchet: every percentage shown to a person goes through
// `formatPercent(value, unit)` from @ainyc/canonry-contracts, so the CLI, the
// dashboard, both report renderers and Aero show the same number the same way
// (one decimal, 0% and 100% only when exact, <0.1% and >99.9% at the edges,
// a dash for a missing value).
//
// It flags a `%` that directly follows a number rounded for display: in a
// template literal (`${(x * 100).toFixed(1)}%`), a concatenation
// (`Math.round(x) + '%'`) or JSX text (`{x.toFixed(0)}%`). CSS geometry is
// layout, not text a person reads, so it is left alone: a `%` after an
// unrounded value (`\`${share * 100}%\``), inside a CSS declaration in markup
// (`style="width:${pct.toFixed(1)}%"`), or as a style object's geometry value
// (`{ width: \`${pct.toFixed(1)}%\` }`).

const ROUNDING_METHODS = new Set(['toFixed', 'toPrecision', 'toLocaleString'])
const MATH_ROUNDING = new Set(['round', 'floor', 'ceil', 'trunc'])
const MAX_DEPTH = 8
const CSS_GEOMETRY = '(?:(?:min-|max-)?(?:width|height)|left|right|top|bottom|inset(?:-[a-z]+)?|flex-basis|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|background-position|transform-origin)'
/** Markup text ending in a CSS geometry declaration: `style="width:` or `; left: 0 `. */
const CSS_DECLARATION_BEFORE = new RegExp(`(?:^|[\\s;"'{])${CSS_GEOMETRY}\\s*:[^;"'{}]*$`, 'i')
/** A style object key naming geometry: `width`, `minHeight`, `flexBasis`. */
const STYLE_GEOMETRY_KEY = /^(?:(?:min|max)?(?:Width|Height|width|height)|left|right|top|bottom|inset\w*|flexBasis|margin\w*|padding\w*|backgroundPosition|transformOrigin)$/

function isStyleGeometryValue(node) {
  const parent = node.parent
  if (!parent || parent.type !== 'Property' || parent.value !== node) return false
  const key = parent.key
  const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : ''
  return STYLE_GEOMETRY_KEY.test(name)
}

function isRoundingCall(node) {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return false
  const name = callee.property.name
  if (ROUNDING_METHODS.has(name)) return true
  if (callee.object.type === 'Identifier' && callee.object.name === 'Math' && MATH_ROUNDING.has(name)) return true
  // new Intl.NumberFormat(...).format(x)
  return name === 'format' && callee.object.type === 'NewExpression' && callee.object.callee.type === 'MemberExpression'
    && callee.object.callee.object.type === 'Identifier' && callee.object.callee.object.name === 'Intl'
}

function childExpressions(node) {
  switch (node.type) {
    case 'CallExpression': return [node.callee, ...node.arguments]
    case 'MemberExpression': return [node.object]
    case 'BinaryExpression':
    case 'LogicalExpression': return [node.left, node.right]
    case 'ConditionalExpression': return [node.consequent, node.alternate]
    case 'UnaryExpression':
    case 'SpreadElement': return [node.argument]
    case 'ChainExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression': return [node.expression]
    case 'TemplateLiteral': return node.expressions
    default: return []
  }
}

function roundsForDisplay(node, depth = 0) {
  if (!node || depth > MAX_DEPTH) return false
  if (isRoundingCall(node)) return true
  return childExpressions(node).some(child => roundsForDisplay(child, depth + 1))
}

function startsWithPercent(node) {
  if (!node) return false
  if (node.type === 'Literal') return typeof node.value === 'string' && node.value.startsWith('%')
  if (node.type === 'TemplateLiteral') return (node.quasis[0]?.value.cooked ?? '').startsWith('%')
  if (node.type === 'JSXText') return node.value.startsWith('%')
  return false
}

export const noInlinePercentRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Show percentages through formatPercent instead of formatting them inline.' },
    schema: [],
    messages: {
      inlinePercent:
        'Show percentages with formatPercent(value, unit) from @ainyc/canonry-contracts: one decimal, 0%/100% only ' +
        'when exact, <0.1%/>99.9% at the edges, a dash for a missing value. Pass unit "percent" for a 0..100 value; ' +
        'ratio fields declare their unit on the schema (fraction() / percent() in contracts ratio-unit.ts).',
    },
  },
  create(context) {
    const report = node => context.report({ node, messageId: 'inlinePercent' })
    return {
      TemplateLiteral(node) {
        if (isStyleGeometryValue(node)) return
        node.expressions.forEach((expression, index) => {
          if (!(node.quasis[index + 1]?.value.cooked ?? '').startsWith('%')) return
          if (CSS_DECLARATION_BEFORE.test(node.quasis[index]?.value.cooked ?? '')) return
          if (roundsForDisplay(expression)) report(expression)
        })
      },
      BinaryExpression(node) {
        if (node.operator === '+' && startsWithPercent(node.right) && roundsForDisplay(node.left)) report(node.left)
      },
      'JSXElement, JSXFragment'(node) {
        node.children.forEach((child, index) => {
          if (child.type === 'JSXExpressionContainer' && startsWithPercent(node.children[index + 1]) && roundsForDisplay(child.expression)) {
            report(child.expression)
          }
        })
      },
    }
  },
}
