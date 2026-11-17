# Cloro

Add an API key in **Settings → Provider connections → Other providers** or run `cnry settings provider cloro --api-key <key>`. Check the key with `cnry settings provider test cloro`.

Select a route explicitly: `cloro:chatgpt`, `cloro:gemini`, `cloro:aimode`, or `cloro:bing-aimode`. Successful requests use Cloro credits.

Canonry sends the query and country (US by default). ChatGPT requests use Cloro’s web-search mode. For Bing AI Mode, only citation chips count as citations.
