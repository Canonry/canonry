import { runCli } from '../src/cli.js'

export async function invokeCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const logs: string[] = []
  const errors: string[] = []
  const writes: string[] = []
  const origLog = console.log
  const origError = console.error
  const origStderrWrite = process.stderr.write
  let exitCode: number | undefined

  console.log = (...parts: unknown[]) => logs.push(parts.join(' '))
  console.error = (...parts: unknown[]) => errors.push(parts.join(' '))
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
    return true
  }) as typeof process.stderr.write

  try {
    const result = await runCli(args)
    exitCode = result === 0 ? undefined : result
  } finally {
    console.log = origLog
    console.error = origError
    process.stderr.write = origStderrWrite
  }

  return {
    stdout: logs.join('\n'),
    stderr: [...errors, ...writes].filter(Boolean).join('\n'),
    exitCode,
  }
}

export function parseJsonOutput(stdout: string): unknown {
  const lines = stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)

  for (let start = 0; start < lines.length; start++) {
    if (!['{', '['].includes(lines[start]![0]!)) continue

    for (let end = lines.length; end > start; end--) {
      const candidate = lines.slice(start, end).join('\n')
      try {
        return JSON.parse(candidate)
      } catch {
        continue
      }
    }
  }

  return JSON.parse(stdout)
}
