// The `canonry-vocabulary` plugin: AGENTS.md "Vocabulary (Critical)" bans,
// loaded by oxlint as a JS plugin (`.oxlintrc.json` → `jsPlugins`). Scopes and
// the permanent exclusions live in `.oxlintrc.json`.
import { createRestrictedSyntaxRule } from './restricted-syntax.js'

// Vocabulary enforcement: per AGENTS.md "Vocabulary (Critical)", user-facing
// labels for `answer_mentioned` must say "mentioned" / "not-mentioned" and
// labels for `citation_state` must say "cited" / "not-cited". The legacy
// umbrella term "visibility" is permitted only when explicitly disambiguated
// (e.g. "Visibility Gap (Citations + Mentions)"). The literals below are
// unambiguous user-facing labels that conflate the two signals — bare
// `'visible'` is excluded because it has legitimate uses (DOM API, the
// legacy `VisibilityState` enum value) that lint cannot disambiguate.
const bannedMetricLiteralRule = createRestrictedSyntaxRule({
  description: 'Disallow legacy / conflated AEO metric literals in operator-facing code.',
  restrictions: [{
    selector: "Literal[value=/^(not-vis|visibility run|visibility sweep|visibility report|answer rate|answer-rate|answerRate)$/]",
    message: 'Use canonical AEO vocabulary: "mentioned" / "not-mentioned" for answer-text presence, "cited" / "not-cited" for source-list presence. See AGENTS.md "Vocabulary (Critical)".',
  }, {
    selector: "Literal[value=/^(paid mentions|paid citations|ad mentions|ad citations|sponsored mentions|sponsored citations|paid-mention|paid-citation)$/]",
    message: 'Paid-surface metrics are "paid" / "sponsored" (impressions, clicks, spend) — never combined with "mentioned"/"cited", which mean organic answer-text / source-list presence. See AGENTS.md "Vocabulary (Critical)".',
  }],
})

// Vocabulary ratchet: the tracked entity is a QUERY, never a "question". See
// AGENTS.md "Vocabulary (Critical) → Query vs question". Advanced measurement
// was the only surface that called it a question; the copy is now query
// everywhere and this keeps it there.
//
// It deliberately does NOT read comments: "question" has plenty of honest
// prose uses in a comment ("both questions go out together"), and flagging
// them would only buy a run of disable-comment lines.
const QUESTION_WORD_RE = /\bquestions?\b/i

// Machine tokens carry the word without being copy: the frozen route paths
// (`/measurement-property-questions`), DOM ids (`property-questions`), and
// busy-state keys (`create-and-pair-questions`). None of them contain a space.
// Prose always does — the one exception being a bare one-word label, which is
// exactly the wizard step that read "Questions".
export function isQuestionUiCopy(text) {
  if (typeof text !== 'string' || !QUESTION_WORD_RE.test(text)) return false
  const trimmed = text.trim()
  return /\s/.test(trimmed) || /^questions?$/i.test(trimmed)
}

// Attributes whose value is an identifier or a class list, never prose. A
// `className` is the realistic one: it is the only non-copy attribute that
// routinely holds spaces, so the heuristic above cannot see it is not a
// sentence.
const QUESTION_COPY_EXEMPT_ATTRIBUTES = new Set([
  'className', 'id', 'htmlFor', 'key', 'name',
  'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns',
])

function isExemptJsxAttributeValue(node) {
  const parent = node.parent
  if (!parent || parent.type !== 'JSXAttribute' || parent.value !== node) return false
  const attribute = parent.name
  const attributeName = attribute?.type === 'JSXNamespacedName'
    ? `${attribute.namespace.name}:${attribute.name.name}`
    : attribute?.name
  return typeof attributeName === 'string'
    && (QUESTION_COPY_EXEMPT_ATTRIBUTES.has(attributeName) || attributeName.startsWith('data-'))
}

const noQuestionUiCopyRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow "question" in web UI copy — the tracked entity is a query.' },
    schema: [],
    messages: {
      questionCopy:
        'The tracked entity is a QUERY, not a "question" — say query in UI copy (labels, headings, ' +
        'buttons, tooltips, aria-labels, placeholders). Mind the plural: "questions" → "queries". ' +
        'The wire names (/measurement-property-questions, /measurement-question-result, the ' +
        'canonry_measurement_* MCP tools, and the SDK symbols derived from them) are FROZEN and ' +
        'exempt. See AGENTS.md "Vocabulary (Critical) → Query vs question".',
    },
  },
  create(context) {
    const report = node => context.report({ node, messageId: 'questionCopy' })
    return {
      // JS strings + JSX attribute values (`text="…"`, `aria-label="…"`, `placeholder="…"`).
      Literal(node) {
        if (isQuestionUiCopy(node.value) && !isExemptJsxAttributeValue(node)) report(node)
      },
      // Visible JSX children — `<h2>Query type</h2>`. Invisible to a `Literal`
      // selector, which is most of what a heading or a table header actually is.
      JSXText(node) {
        if (isQuestionUiCopy(node.value)) report(node)
      },
      // Interpolated copy — `${n} query assignments`.
      TemplateElement(node) {
        if (isQuestionUiCopy(node.value.raw)) report(node)
      },
    }
  },
}

export default {
  meta: { name: 'canonry-vocabulary' },
  rules: {
    'no-banned-metric-literal': bannedMetricLiteralRule,
    'no-question-ui-copy': noQuestionUiCopyRule,
  },
}
