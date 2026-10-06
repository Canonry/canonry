# Upstream provenance

Imported on 2026-10-03 from [OpenClaw's test-audit skill](https://github.com/openclaw/openclaw/tree/main/.agents/skills/test-audit).

The fetched Git blob IDs pin the imported contents:

- `SKILL.md`: `10418bd560c7b054025aed99fb9e13f1f2522be0`
- `CAMPAIGN.md`: `f29346bf430228deb9d1d4c03157fdbfffce7c8e`
- `LICENSE`: `ed064819ab537575d0cad902f7e5af4a3488b1d0`

`CAMPAIGN.md` is unchanged. `SKILL.md` preserves the authoring gate, audit
patterns, value and retention bars, candidate evidence, and handoff.
Its trigger also covers running tests. Discovery paths, validation, independent
review, and landing instructions use Canonry's repository rules instead of
OpenClaw's unavailable skills and scripts.

This development skill lives in `.agents/skills/` and is read through the root
`AGENTS.md`. It is separate from the operator skills shipped in `skills/`
and `plugins/canonry/`; it does not change the published Canonry plugin.
The accompanying MIT license applies to the upstream skill.
