import { describe, expect, it } from "vitest";
import { extractAnchoredSpans } from "../src/index.js";

// Claude puts each cited claim in its own text block; the name usually leads
// it in the uncited block before. Fictional response with the stored shape.

function citation(url: string) {
  return { type: "web_search_result_location", url, title: "Fictional page", cited_text: "Source page words, never read.", encrypted_index: "e" };
}

describe("extractAnchoredSpans (Claude)", () => {
  it("joins the uncited lead-in line to the cited block, once per cited URL", () => {
    const response = {
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "bike tune-ups" } },
        { type: "web_search_tool_result", content: [] },
        { type: "text", text: "Here are options:\n\n- **TuneSpoke** - " },
        { type: "text", text: "Mobile tune-ups on the east side.", citations: [citation("https://spoketuneworks.example/services"), citation("https://spoketuneworks.example/services"), citation("https://reviews.example/tunespoke")] },
        { type: "text", text: "\n\n### Rim Doctor\n" },
        { type: "text", text: "Wheel truing while you wait.", citations: [citation("https://rimdoctor.example/")] },
        { type: "text", text: "Prices vary.", citations: [citation("https://qvx.example/")] },
      ],
    };
    expect(extractAnchoredSpans(response)).toEqual([
      { text: "- **TuneSpoke** - Mobile tune-ups on the east side.", source: "https://spoketuneworks.example/services", kind: "window", via: "claude-citation" },
      { text: "- **TuneSpoke** - Mobile tune-ups on the east side.", source: "https://reviews.example/tunespoke", kind: "window", via: "claude-citation" },
      { text: "### Rim Doctor\nWheel truing while you wait.", source: "https://rimdoctor.example/", kind: "window", via: "claude-citation" },
      // A cited block is never the lead-in of the next one.
      { text: "Prices vary.", source: "https://qvx.example/", kind: "window", via: "claude-citation" },
    ]);
  });

  it("yields nothing for uncited answers or unusable content", () => {
    expect(extractAnchoredSpans({ content: [{ type: "text", text: "- **TuneSpoke** - tune-ups" }] })).toEqual([]);
    expect(extractAnchoredSpans({ content: "nope" })).toEqual([]);
  });
});
