export type CliFormat = 'text' | 'json'

/**
 * Exit codes follow a convention agents can branch on:
 *   0 = success
 *   1 = user error (bad input, not found, validation — do not retry)
 *   2 = system error (network, provider failure, internal — may retry)
 */
export const EXIT_USER_ERROR = 1
export const EXIT_SYSTEM_ERROR = 2

type CliErrorOptions = {
  code: string
  message: string
  displayMessage?: string
  details?: Record<string, unknown>
  exitCode?: typeof EXIT_USER_ERROR | typeof EXIT_SYSTEM_ERROR
}

export class CliError extends Error {
  readonly code: string
  readonly displayMessage?: string
  readonly details?: Record<string, unknown>
  readonly exitCode: number

  constructor(options: CliErrorOptions) {
    super(options.message)
    this.name = 'CliError'
    this.code = options.code
    this.displayMessage = options.displayMessage
    this.details = options.details
    this.exitCode = options.exitCode ?? EXIT_USER_ERROR
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

/**
 * Returns true if the error looks like "this endpoint doesn't exist on the server".
 * Used by clients that want to fall back to an older API path when talking to a
 * server predating a new composite endpoint. Narrow on 404/405 only — do NOT
 * treat other HTTP errors (auth, 500s, network) as a fallback signal.
 */
export function isEndpointMissing(err: unknown): boolean {
  if (!(err instanceof CliError)) return false
  const status = err.details?.httpStatus
  return status === 404 || status === 405
}

export function systemError(
  message: string,
  options?: {
    displayMessage?: string
    details?: Record<string, unknown>
  },
): CliError {
  return new CliError({
    code: 'CLI_SYSTEM_ERROR',
    message,
    displayMessage: options?.displayMessage,
    details: options?.details,
    exitCode: EXIT_SYSTEM_ERROR,
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
