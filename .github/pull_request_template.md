<!-- Complete before opening the PR, including drafts. See CONTRIBUTING.md.
Use 1–3 summary bullets, at most 75 words. No file inventory or repeated narrative.
Check only completed items. For inapplicable items, write N/A — reason beside them.
Required failures or missing results block submission without a maintainer exception.
-->

## Summary

- Describe the problem and resulting behavior. Link the issue if applicable.

## Checklist

- [ ] Followed root and scoped `AGENTS.md` rules, including code style.
- [ ] Reviewed potential security issues and recorded risks/mitigations below.
- [ ] Required tests passed; included full-suite totals for outside code contributions.
- [ ] Required typechecks, type-aware lint, and generated-file checks passed (`pnpm verify` for outside code contributions).
- [ ] Affected build and smoke checks passed, including Simple/Advanced paths where applicable.
- [ ] UI styling matches `PRODUCT.md`/`DESIGN.md`; desktop/mobile, keyboard checks, and before/after screenshots attached.
- [ ] Evidence covers the submitted head; reran checks whose inputs changed.

## Evidence

- Commit: `<tested SHA>`
- Checks: `<exact command → result; test pass/fail/skip counts; sanitized log links or collapsed logs>`
- Security: `<potential risks and mitigations, or None identified + reviewed areas>`
- UI: `<screenshots and observed results, or N/A — reason>`
