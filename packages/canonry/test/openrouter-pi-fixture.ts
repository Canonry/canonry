/** Literal Anthropic SSE frames accepted by OpenRouter's messages endpoint. */
export function openRouterMessagesReply(text: string): string {
  return [
    { type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'synthetic-served-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** An OpenAI-compatible streamed completion, as OpenRouter's chat completions endpoint sends it. */
export function openRouterCompletionsReply(model: string, text: string): string {
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: 'gen-synthetic', object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`
  return chunk({ delta: { role: 'assistant', content: text }, finish_reason: null })
    + chunk({ delta: {}, finish_reason: 'stop' }, { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })
    + 'data: [DONE]\n\n'
}
