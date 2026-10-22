// Selector bans that COMPOSE instead of clobbering each other.
//
// The core `no-restricted-syntax` rule cannot be used more than once over the
// same file: the linter resolves rules by ID with LAST-WINS OVERRIDE across
// overlapping config blocks (ESLint flat config did, and `.oxlintrc.json`
// overrides do), so a second block naming the same tree REPLACES the first
// block's options wholesale. The earlier guard then reports
// nothing, at any verbosity, with no warning, no duplicate-rule diagnostic, and
// a fully green `pnpm lint`. Four of the five `no-restricted-syntax` blocks in
// the former `eslint.config.js` were dead this way (verified 2026-08-05 by probe file), and
// the AGENTS.md rules they were supposed to back had been false for as long.
//
// A guard with its OWN rule id is immune: two different ids are two different
// rules and both run. This factory turns each ban into such a rule, so the cost
// of a unique id is one `createRestrictedSyntaxRule(...)` call rather than a
// hand-written visitor per guard. Behavior matches `no-restricted-syntax`: each
// restriction is an esquery selector plus the message to report on a match.
//
// Each guard's selectors and messages live in its plugin module
// (`canonry-guards.js`, `canonry-vocabulary.js`); its `files` scope and
// exemptions live in `.oxlintrc.json`.

/**
 * An ESLint-format rule module, as oxlint's JS plugins run it. oxlint exposes
 * the type only as `RuleTester.run`'s rule parameter.
 * @typedef {Parameters<import('oxlint/plugins-dev').RuleTester['run']>[1]} OxlintRule
 */

const messageIdAt = (index) => `restricted${index}`

/**
 * @param {object} options
 * @param {string} options.description What the guard bans, for `meta.docs`.
 * @param {Array<{ selector: string, message: string }>} options.restrictions
 *   esquery selectors and the message reported on a match — same shape as a
 *   `no-restricted-syntax` option object.
 * @returns {OxlintRule}
 */
export function createRestrictedSyntaxRule({ description, restrictions }) {
  if (!Array.isArray(restrictions) || restrictions.length === 0) {
    throw new Error('createRestrictedSyntaxRule: `restrictions` must be a non-empty array of { selector, message }')
  }

  const messages = {}
  for (const [index, restriction] of restrictions.entries()) {
    if (!restriction?.selector || !restriction?.message) {
      throw new Error(`createRestrictedSyntaxRule: restriction ${index} needs both a \`selector\` and a \`message\``)
    }
    messages[messageIdAt(index)] = restriction.message
  }

  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages,
    },
    create(context) {
      const visitor = {}
      for (const [index, restriction] of restrictions.entries()) {
        const messageId = messageIdAt(index)
        const report = (node) => context.report({ node, messageId })
        // Two restrictions in one rule may legitimately share a selector (same
        // node shape, different message). Chain them — letting the later one
        // overwrite the visitor key would reintroduce, inside a single rule,
        // exactly the silent clobber this module exists to remove.
        const previous = visitor[restriction.selector]
        visitor[restriction.selector] = previous
          ? (node) => { previous(node); report(node) }
          : report
      }
      return visitor
    },
  }
}
