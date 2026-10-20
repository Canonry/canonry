// The `design-tokens` plugin, loaded by oxlint as a JS plugin (`.oxlintrc.json`
// → `jsPlugins`). Design-token migration ratchet (engine issue #767, Phase 3):
// flags raw Tailwind palette color utilities in themeable web code so a
// migrated file can't regress. The rule and its regex live in
// ./no-literal-palette.js (shared with the scanner and its test). Phase 3 is
// complete: the rule covers all of apps/web/src, with only the two permanent
// exclusions listed in `.oxlintrc.json`.
import { noLiteralPaletteRule } from './no-literal-palette.js'

export default {
  meta: { name: 'design-tokens' },
  rules: { 'no-literal-palette': noLiteralPaletteRule },
}
