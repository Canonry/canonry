import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'
import { noSecondQueryClassifierRule } from '../eslint-rules/no-second-query-classifier.js'

/**
 * The guard fails a module that classes tracked queries as branded or non-brand
 * on its own. Every `invalid` case below is a way such a classifier has been or
 * would be written; every `valid` case is code that reads a class it was given,
 * which the guard must leave alone or it would be disabled within a week.
 */
describe('canonry-guards/no-second-query-classifier', () => {
  RuleTester.describe = describe
  RuleTester.it = it
  // `RuleTester.run` declares its own suite, so it is called at describe time.
  new RuleTester({
    languageOptions: { parser: tseslint.parser },
  }).run('no-second-query-classifier', noSecondQueryClassifierRule, {
    valid: [
      // The one classifier, and a class read back from the server.
      'const queryClass = compileQueryClassifier(effectiveBrandNames(project))?.classify(row.query) ?? null',
      'const queryClass = classes.get(row.id) ?? null',
      // Mapping a class that already exists: the test compares against a class.
      "const other = queryClass === 'branded' ? 'non-brand' : 'branded'",
      "const selected = selection.queryClass === 'non-brand' ? 'non-brand' : 'branded'",
      "const shown: QueryClass = !isAssigned('non-brand') && isAssigned('branded') ? 'branded' : 'non-brand'",
      "function flip(queryClass: QueryClass): QueryClass { if (queryClass === 'branded') return 'non-brand'; return 'branded' }",
      "function flip(queryClass: QueryClass): QueryClass { switch (queryClass) { case 'branded': return 'non-brand'; case 'non-brand': return 'branded' } }",
      // Class values that are listed, not derived.
      "const QUERY_CLASSES = ['branded', 'non-brand'] as const",
      "const summaries = { branded: summarize('branded'), nonBrand: summarize('non-brand') }",
      // Display labels are not the class.
      "const heading = isBranded ? 'Branded' : 'Non-brand'",
      // One class per function is not a classifier.
      "function defaultClass() { return 'non-brand' }",
      "function outer() { function inner() { return 'branded' } return 'non-brand' }",
      "function start() { let queryClass: QueryClass = 'non-brand'; queryClass = 'non-brand'; return queryClass }",
      // Both classes written from a class that is read, not from a test of the text.
      "function flip(row: Row) { if (row.queryClass === 'branded') row.queryClass = 'non-brand'; else row.queryClass = 'branded' }",
      // Module constants name the classes; nothing is derived.
      "const BRANDED = 'branded'; const NON_BRAND = 'non-brand'",
      // A default parameter and an object field are not assignments of a derived class.
      "function read(queryClass: QueryClass = 'non-brand') { return load({ queryClass, other: 'branded' }) }",
      // The brand matcher over answer prose is mention detection, not query classing.
      'const mentioned = matcherMatchesText(matcher, answerProseForMentions(snapshot.answerText))',
      'const named = textContainsBrandAlias(ctx.answerText, hint)',
      'const found = matchedAliasKeys(matcher, answer.prose)',
    ],
    invalid: [
      // The copy this guard was written against: the matcher inlined into a ternary.
      {
        code: "const queryClass = matcherMatchesText(matcher, queryText) ? 'branded' : 'non-brand'",
        errors: [{ messageId: 'derivedClass' }, { messageId: 'brandMatchOnQueryText' }],
      },
      // Any other signal turned into the class by hand.
      { code: "const queryClass = /example/i.test(text) ? 'branded' : 'non-brand'", errors: [{ messageId: 'derivedClass' }] },
      { code: "const queryClass = text.toLowerCase().includes(brand) ? 'branded' : 'non-brand'", errors: [{ messageId: 'derivedClass' }] },
      { code: "const queryClass = hit ? ('branded' as const) : ('non-brand' as const)", errors: [{ messageId: 'derivedClass' }] },
      { code: 'const queryClass = hit ? `branded` : `non-brand`', errors: [{ messageId: 'derivedClass' }] },
      // A chain reports once, at its outermost conditional.
      { code: "const queryClass = names.length === 0 ? null : hit ? 'branded' : 'non-brand'", errors: [{ messageId: 'derivedClass' }] },
      { code: "const queryClass = hit ? 'branded' : other ? 'non-brand' : null", errors: [{ messageId: 'derivedClass' }] },
      // The same thing as statements.
      {
        code: "function classify(text: string) { if (text.includes(brand)) return 'branded'; return 'non-brand' }",
        errors: [{ messageId: 'derivedClass' }],
      },
      {
        code: "const classify = (text: string): QueryClass => { if (BRAND_RE.test(text)) { return 'branded' } return 'non-brand' }",
        errors: [{ messageId: 'derivedClass' }],
      },
      // The same thing again with the class held in a variable or written onto a row.
      {
        code: "function classOf(text: string, brand: string) { let cls: QueryClass = 'non-brand'; if (text.toLowerCase().includes(brand.toLowerCase())) cls = 'branded'; return cls }",
        errors: [{ messageId: 'derivedClass' }],
      },
      {
        code: "function tag(rows: Row[]) { for (const row of rows) { if (re.test(row.query)) row.queryClass = 'branded'; else row.queryClass = 'non-brand' } }",
        errors: [{ messageId: 'derivedClass' }],
      },
      // A default that is returned unless a test passes.
      {
        code: "const classify = (text: string): QueryClass => { const fallback: QueryClass = 'non-brand'; if (BRAND_RE.test(text)) return 'branded'; return fallback }",
        errors: [{ messageId: 'derivedClass' }],
      },
      // A classifier that never writes the class literal still runs the matcher over query text.
      {
        code: 'const brandedQueries = queries.filter(q => textContainsAnyBrandAlias(q.query, names))',
        errors: [{ messageId: 'brandMatchOnQueryText' }],
      },
      {
        code: 'const isBranded = matcherMatchesText(matcher, normalizeQueryText(row.query).trim())',
        errors: [{ messageId: 'brandMatchOnQueryText' }],
      },
      { code: 'const isBranded = contracts.textContainsBrandAlias(keyword, alias)', errors: [{ messageId: 'brandMatchOnQueryText' }] },
      { code: 'const keys = matchedAliasKeys(matcher, frozen.queryText ?? "")', errors: [{ messageId: 'brandMatchOnQueryText' }] },
    ],
  })
})
