# AI Visibility Check

Enter a domain. See whether an AI answer engine mentions your brand and cites your site.

Free. No signup. About 45 seconds.

## Signals

Two signals, measured separately.

| Signal | Meaning |
|---|---|
| Mentioned | Your brand appears in the text the engine wrote. |
| Cited | Your domain appears in the sources behind the answer. |

They are independent. A site can be cited without being named, or named without being cited.

## Results

- Three questions generated for your site
- The full answer text
- Mentioned and cited per question, with the sources used
- A technical audit of a sample of pages
- A map of how those pages link to each other

A failed check is reported as failed, not scored as zero.

## MCP

This is also an MCP server. No API key.

```json
{ "mcpServers": { "ai-visibility-check": { "url": "https://<host>/mcp" } } }
```

Tools: `start_check`, `get_check`, `get_ai_visibility`, `get_site_health`, `self_host`.

## Limits

- One engine (Gemini)
- Three generated questions
- Five pages of audit
- One snapshot. No history, no tracking, no alerts

## Canonry

Canonry is the open source platform this samples. It runs on your own machine.

```sh
npm install -g @canonry/canonry
canonry init
```

Four answer engines. Unlimited questions on a schedule. Whole-site audits. History, competitor share, and joins to
Search Console, GA4, and Bing.

[github.com/Canonry/canonry](https://github.com/Canonry/canonry) · [canonry.ai](https://canonry.ai)
