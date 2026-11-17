/**
 * Run `dispatch` every `intervalMs` until the returned stop function is
 * called. Passes never overlap: a tick while one is still running is skipped.
 * A failed pass goes to `onError` and the next tick tries again. The timer
 * never keeps the process alive.
 */
export function startAlertLoop(dispatch: () => Promise<unknown>, intervalMs: number, onError: (err: unknown) => void): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void dispatch()
      .catch(onError)
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
