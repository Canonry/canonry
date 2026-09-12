import { detectAgentRuntime } from '@ainyc/canonry-contracts'

export interface CliRuntimeContext {
  /** Coding agent the process runs under (`claude`, `codex`, ...), or `none`. */
  agent: string
  /** Both stdin and stdout are terminals: a person at a shell rather than a harness. */
  interactive: boolean
}

/**
 * Who is driving this process. Canonry is agent first, so every CLI lifecycle
 * event carries it: an agent-driven install and a human one are different
 * funnels, and pooling them hides which of the two retains.
 */
export function cliRuntimeContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
  stdio: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process,
): CliRuntimeContext {
  return {
    agent: detectAgentRuntime(env),
    interactive: Boolean(stdio.stdin.isTTY && stdio.stdout.isTTY),
  }
}
