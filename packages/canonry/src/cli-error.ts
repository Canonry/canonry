export type CliFormat = 'text' | 'json'

type CliErrorOptions = {
  code: string
  message: string
  displayMessage?: string
  details?: Record<string, unknown>
}

export class CliError extends Error {
  readonly code: string
  readonly displayMessage?: string
  readonly details?: Record<string, unknown>

  constructor(options: CliErrorOptions) {
    super(options.message)
    this.name = 'CliError'
    this.code = options.code
    this.displayMessage = options.displayMessage
    this.details = options.details
  }
}

export function usageError(
  displayMessage: string,
  options?: {
    message?: string
    details?: Record<string, unknown>
  },
): CliError {
  const firstLine = displayMessage.split('\n', 1)[0] ?? 'Error: invalid command usage'
  return new CliError({
    code: 'CLI_USAGE_ERROR',
    message: options?.message ?? firstLine.replace(/^Error:\s*/, ''),
    displayMessage,
    details: options?.details,
  })
}

export function printCliError(err: unknown, format: CliFormat): void {
  if (format === 'json') {
    if (err instanceof CliError) {
      console.error(
        JSON.stringify(
          {
            error: {
              code: err.code,
              message: err.message,
              ...(err.details ? { details: err.details } : {}),
            },
          },
          null,
          2,
        ),
      )
      return
    }

    const message = err instanceof Error ? err.message : 'An unexpected error occurred'
    console.error(
      JSON.stringify(
        {
          error: {
            code: 'CLI_ERROR',
            message,
          },
        },
        null,
        2,
      ),
    )
    return
  }

  if (err instanceof CliError && err.displayMessage) {
    console.error(err.displayMessage)
    return
  }

  if (err instanceof Error) {
    console.error(`Error: ${err.message}`)
    return
  }

  console.error('An unexpected error occurred')
}
