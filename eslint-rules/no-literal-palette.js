// Design-token migration ratchet (engine issue #767, Phase 3): the single source
// of truth for "what is a raw Tailwind palette utility". Imported by:
//   - eslint.config.js                      (the enforced gate)
//   - apps/web/scripts/scan-raw-colors.mjs  (progress report)
//   - apps/web/test/no-literal-palette.test.ts (behavior lock)
//
// Exported as a SOURCE STRING (not a RegExp) so each consumer builds its own
// RegExp with the flags it needs: the rule uses non-global `.test()`, the
// scanner uses a global `.match()` to count. Sharing one compiled global regex
// across `.test()` calls would carry `lastIndex` state between nodes and skip
// matches, so the string is the safe unit to share.
//
// Covers every color utility form in use plus directional/logical border colors
// (`border-t-zinc-500`, `border-s-rose-400`) so a future one can't slip the gate.
// It deliberately does NOT match the token scales (`mono-*`, `positive-*`,
// `caution-*`, `negative-*`, `info-*`) or the semantic role tokens — only the
// raw Tailwind default palette names.
export const RAW_PALETTE_SOURCE =
  '\\b(?:bg|text|border(?:-[trblxyse])?|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow|ring-offset)-' +
  '(?:zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-' +
  '(?:50|100|200|300|400|500|600|700|800|900|950)\\b'

const RAW_PALETTE_RE = new RegExp(RAW_PALETTE_SOURCE)

export const noLiteralPaletteRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw Tailwind palette color utilities in themeable web code (design-token migration).' },
    schema: [],
    messages: {
      rawPalette:
        'Raw Tailwind palette utility in themeable web code. Use a semantic token (bg-surface, ' +
        'text-secondary, border-default, ...) or a scale token (mono-*/positive-*/caution-*/negative-*/info-*). ' +
        'See apps/web/AGENTS.md "Design tokens".',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string' && RAW_PALETTE_RE.test(node.value)) {
          context.report({ node, messageId: 'rawPalette' })
        }
      },
      TemplateElement(node) {
        if (RAW_PALETTE_RE.test(node.value.raw)) {
          context.report({ node, messageId: 'rawPalette' })
        }
      },
    }
  },
}
