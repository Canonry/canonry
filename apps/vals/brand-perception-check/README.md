# Brand Perception Check

Enter a domain. See what an AI answer engine says about your brand when someone asks it directly.

Free. No signup. About 45 seconds.

## What you get

Three questions people actually type — "is X legit?", "X reviews", "what are the complaints about X?" — put to an
answer engine, and for each one:

| | |
|---|---|
| **The verdict** | Recommends, cautions, mixed, or took no position. |
| **The sentences behind it** | Copied out of the answer word for word. Never a paraphrase. |
| **The concerns** | Short phrases the answer itself raises as drawbacks. |
| **The sources** | What the engine attributed, by kind: the brand's own site, community, review site, news, other. |

No sentiment score. Nothing here measures feeling, so nothing here pretends to. You get what the answer said and the
line it said it in.

An answer that took no position says so. An answer the check could not measure says that instead, and is left out of
every count rather than scored as a zero.

## This is not a visibility check

Every question here names your brand, so the engine was always going to talk about you. The finding is what it SAID.

Whether AI mentions you at all, on questions that do not name you, is a different measurement —
[AI Visibility Check](https://github.com/Canonry/canonry) is the tool for that. The two numbers are never comparable.

## MCP

This is also an MCP server. No API key.

```json
{ "mcpServers": { "brand-perception-check": { "url": "https://<host>/mcp" } } }
```

Tools: `start_check`, `get_check`, `get_brand_perception`, `self_host`.

## Limits

- One engine (Gemini)
- Three branded questions
- One snapshot. No history, no tracking, no alerts

## Canonry

Canonry is the open source platform this samples. It runs on your own machine.

```sh
npm install -g @canonry/canonry
canonry init
```

Four answer engines. Unlimited questions on a schedule. History, so you can watch a concern appear, spread, or go away.
Non-brand tracking, competitor share, whole-site audits, and joins to Search Console, GA4, and Bing.

[github.com/Canonry/canonry](https://github.com/Canonry/canonry) · [canonry.ai](https://canonry.ai)
