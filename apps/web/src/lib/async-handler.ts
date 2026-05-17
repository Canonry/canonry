/**
 * Wrap an async handler so it can be used in a React event-handler slot that
 * expects `() => void` (onClick, onSubmit, onClose, etc.) without tripping
 * `@typescript-eslint/no-misused-promises`. Discards the returned promise.
 */
export function asyncHandler<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<unknown>,
): (...args: TArgs) => void {
  return (...args) => {
    void fn(...args)
  }
}
