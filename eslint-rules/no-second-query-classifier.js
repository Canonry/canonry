// One query classifier: a tracked query is branded or non-brand because
// `compileQueryClassifier` (packages/contracts/src/query-class.ts) says so, or
// because an advanced measurement plan stored that class. A second classifier
// with its own rules splits the two figures differently on different surfaces,
// and nothing at runtime notices.
//
// A class cannot be recognized by type, so this rule looks for the three shapes
// a hand-written classifier takes:
//
//   1. A conditional that turns something that is not a class into the two
//      class literals: `nameHit ? 'branded' : 'non-brand'`.
//   2. A function that produces both class literals without reading a class,
//      whether it returns them, holds them in a variable or writes them onto a
//      row: `if (re.test(text)) return 'branded'; return 'non-brand'`,
//      `let cls = 'non-brand'; if (hit) cls = 'branded'`,
//      `if (hit) row.queryClass = 'branded'; else row.queryClass = 'non-brand'`.
//   3. A brand matcher primitive run over query text:
//      `textContainsAnyBrandAlias(row.query, names)`.
//
// Code that reads a class it was given is left alone, because it maps a class
// and does not derive one: `queryClass === 'branded' ? 'non-brand' : 'branded'`
// compares against a class literal in its test, and so does a `switch` over a
// class. Shape 3 goes by the name of the text argument (`query`, `queryText`,
// `row.query`, `keyword`, `q`); answer prose and alias lists are not query text.
//
// What it cannot see: a classifier that stores a boolean and never writes a
// class literal, over text held in a variable not named for a query; and class
// literals written only as object fields or call arguments, which is also how
// code that lists both classes looks. The parity test in
// packages/api-routes/test/query-class-parity.test.ts covers the server call
// sites from the other side.

const QUERY_CLASSES = new Set(['branded', 'non-brand'])
const CLASS_LITERAL_IN_SOURCE = /(['"`])(?:branded|non-brand)\1/
const EQUALITY_OPERATORS = new Set(['===', '!==', '==', '!='])
const ASSIGNMENT_OPERATORS = new Set(['=', '??=', '||=', '&&='])
/** Brand matcher primitives, and which argument is the text they search. */
const BRAND_MATCHER_TEXT_ARGUMENT = new Map([
  ['matcherMatchesText', 1],
  ['matchedAliasKeys', 1],
  ['textContainsBrandAlias', 0],
  ['textContainsAnyBrandAlias', 0],
])
const QUERY_TEXT_NAME = /^q$|quer(?:y|ies)|keyword/i
const MAX_UNWRAP_DEPTH = 8

function unwrapTypeSyntax(node) {
  let current = node
  while (current && (
    current.type === 'TSAsExpression'
    || current.type === 'TSSatisfiesExpression'
    || current.type === 'TSNonNullExpression'
    || current.type === 'TSTypeAssertion'
  )) current = current.expression
  return current
}

/** `'branded'` or `'non-brand'` when the node is that literal, else null. */
function classLiteral(node) {
  const value = unwrapTypeSyntax(node)
  if (!value) return null
  if (value.type === 'Literal' && QUERY_CLASSES.has(value.value)) return value.value
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
    const text = value.quasis[0]?.value.cooked
    return QUERY_CLASSES.has(text) ? text : null
  }
  return null
}

/** The class literals a conditional can evaluate to, and every test it branches on. */
function conditionalOutcomes(node, classes = new Set(), tests = []) {
  tests.push(node.test)
  for (const branch of [node.consequent, node.alternate]) {
    const value = unwrapTypeSyntax(branch)
    if (value.type === 'ConditionalExpression') conditionalOutcomes(value, classes, tests)
    else {
      const literal = classLiteral(value)
      if (literal) classes.add(literal)
    }
  }
  return { classes, tests }
}

function isConditionalBranch(node) {
  let child = node
  let parent = node.parent
  while (parent && unwrapTypeSyntax(parent) !== parent) {
    child = parent
    parent = parent.parent
  }
  return parent?.type === 'ConditionalExpression' && parent.test !== child
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name
  }
  return null
}

/** The name the text argument goes by: `row.query` and `normalize(query).trim()` are both `query`. */
function subjectName(node) {
  let current = node
  for (let depth = 0; current && depth < MAX_UNWRAP_DEPTH; depth++) {
    current = unwrapTypeSyntax(current)
    if (current.type === 'Identifier') return current.name
    if (current.type === 'ChainExpression') current = current.expression
    else if (current.type === 'LogicalExpression') current = current.left
    else if (current.type === 'MemberExpression') {
      if (!current.computed && current.property.type === 'Identifier') return current.property.name
      current = current.object
    } else if (current.type === 'CallExpression') {
      // `query.trim()` is still the query; so is `normalizeQueryText(query)`.
      current = current.callee.type === 'MemberExpression' ? current.callee.object : current.arguments[0]
    } else return null
  }
  return null
}

/** @type {import('./restricted-syntax.js').OxlintRule} */
export const noSecondQueryClassifierRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Classify tracked queries as branded or non-brand only through compileQueryClassifier.' },
    schema: [],
    messages: {
      derivedClass:
        'This derives a branded / non-brand class by hand. Tracked queries have ONE classifier: '
        + 'compileQueryClassifier(effectiveBrandNames(project)) from @canonry/canonry-contracts '
        + '(packages/contracts/src/query-class.ts). Call it, or read the class the server already resolved '
        + '(queryClass on GET /projects/:name/queries, or the assignment class in an advanced plan). '
        + 'See AGENTS.md "Branded vs non-brand" rule 5.',
      brandMatchOnQueryText:
        'This runs a brand matcher over query text, which is a second branded / non-brand classifier. '
        + 'Use compileQueryClassifier(effectiveBrandNames(project)).classify(queryText) from '
        + '@canonry/canonry-contracts instead. See AGENTS.md "Branded vs non-brand" rule 5.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const readsClass = node => CLASS_LITERAL_IN_SOURCE.test(sourceCode.getText(node))
    /**
     * One frame per enclosing function: the classes it produces (returns,
     * assigns, or declares a variable with), and whether it compares against one.
     */
    const functions = []
    const enterFunction = node => functions.push({ node, produced: new Set(), readsClass: false })
    const exitFunction = () => {
      const frame = functions.pop()
      if (frame && frame.produced.size === QUERY_CLASSES.size && !frame.readsClass) {
        context.report({ node: frame.node, messageId: 'derivedClass' })
      }
    }
    const markClassProduced = value => {
      const literal = classLiteral(value)
      if (literal) functions.at(-1)?.produced.add(literal)
    }
    const markClassRead = () => {
      const frame = functions.at(-1)
      if (frame) frame.readsClass = true
    }

    return {
      ConditionalExpression(node) {
        // The outermost conditional of a chain speaks for the whole chain.
        if (isConditionalBranch(node)) return
        const { classes, tests } = conditionalOutcomes(node)
        if (classes.size === QUERY_CLASSES.size && !tests.some(readsClass)) {
          context.report({ node, messageId: 'derivedClass' })
        }
      },
      FunctionDeclaration: enterFunction,
      FunctionExpression: enterFunction,
      ArrowFunctionExpression: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      'FunctionExpression:exit': exitFunction,
      'ArrowFunctionExpression:exit': exitFunction,
      ReturnStatement(node) {
        markClassProduced(node.argument)
      },
      AssignmentExpression(node) {
        if (ASSIGNMENT_OPERATORS.has(node.operator)) markClassProduced(node.right)
      },
      VariableDeclarator(node) {
        markClassProduced(node.init)
      },
      BinaryExpression(node) {
        if (EQUALITY_OPERATORS.has(node.operator) && (classLiteral(node.left) || classLiteral(node.right))) markClassRead()
      },
      SwitchCase(node) {
        if (classLiteral(node.test)) markClassRead()
      },
      CallExpression(node) {
        const name = calleeName(node.callee)
        const textIndex = name === null ? undefined : BRAND_MATCHER_TEXT_ARGUMENT.get(name)
        if (textIndex === undefined) return
        const subject = subjectName(node.arguments[textIndex])
        if (subject !== null && QUERY_TEXT_NAME.test(subject)) {
          context.report({ node, messageId: 'brandMatchOnQueryText' })
        }
      },
    }
  },
}
