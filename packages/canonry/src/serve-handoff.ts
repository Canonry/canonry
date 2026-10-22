import type { CliFormat } from './cli-error.js'

/**
 * Hand control to `canonry serve` after init finishes.
 *
 * A flag rather than a direct call, because init's own lifecycle telemetry is
 * emitted by the dispatcher when the command RETURNS. Serve never returns, so
 * launching it from inside init would record every init that chose the
 * dashboard as a half-hour command. The dispatcher runs the hand-off after the
 * init event is on the wire.
 *
 * This module stays small because the dispatcher imports it on every run:
 * init and serve load only when they are used. The serve import cannot sit
 * in cli.ts: tsx fails to lex a dynamic import in a file that starts with a
 * shebang.
 */
let pendingServeHandoff = false

/** Called by init when the operator chooses to start the dashboard. */
export function queueServeHandoff(): void {
  pendingServeHandoff = true
}

/** Starts the dashboard if init queued the hand-off. */
export async function runPendingServeHandoff(format: CliFormat): Promise<void> {
  if (!pendingServeHandoff) return
  pendingServeHandoff = false
  const { serveCommand } = await import('./commands/serve.js')
  await serveCommand(format)
}
