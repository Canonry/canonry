/**
 * One expensive per-project pass at a time, with bursts coalesced.
 *
 * `request(projectId)` resolves with the result of a pass that STARTED after
 * the request: with nothing running it starts one; while one runs it queues
 * exactly one follow-up, which every request made during that run shares. So
 * a burst costs at most two passes per project (the running one and one
 * follow-up), two passes of one project never overlap, and a caller never
 * receives a result computed before it asked. Different projects run
 * independently. With `joinRunning`, a request made during a pass shares that
 * pass instead (a read-only dry run, where a scan already under way is fresh
 * enough), so concurrent requests cost one pass.
 *
 * Used for answer-derived competitor alias detection (the post-run trigger,
 * `POST /competitor-auto-aliases`, and the dry run each through their own
 * queue) and for the stored competitor-fields recompute that a names change
 * triggers.
 */
export interface ProjectPassQueue<T> {
  request(projectId: string): Promise<T>
  /** Resolves once no pass is running or queued for any project. */
  settled(): Promise<void>
}

interface ProjectSlot<T> {
  running: Promise<T>
  next: { promise: Promise<T>; start: () => void } | null
}

export function createProjectPassQueue<T>(
  run: (projectId: string) => Promise<T>,
  opts: { joinRunning?: boolean } = {},
): ProjectPassQueue<T> {
  const slots = new Map<string, ProjectSlot<T>>()

  const launch = (projectId: string, pass: () => Promise<T>): Promise<T> => {
    const running = pass()
    const slot: ProjectSlot<T> = { running, next: null }
    slots.set(projectId, slot)
    const finish = (): void => {
      const queued = slot.next
      if (queued) {
        queued.start()
        return
      }
      if (slots.get(projectId) === slot) slots.delete(projectId)
    }
    running.then(finish, finish)
    return running
  }

  return {
    request(projectId) {
      const slot = slots.get(projectId)
      if (!slot) return launch(projectId, () => run(projectId))
      if (opts.joinRunning) return slot.running
      if (slot.next) return slot.next.promise
      let start!: () => void
      const promise = new Promise<T>((resolve, reject) => {
        start = () => {
          launch(projectId, () => run(projectId)).then(resolve, reject)
        }
      })
      slot.next = { promise, start }
      return promise
    },
    async settled() {
      while (slots.size > 0) {
        await Promise.allSettled([...slots.values()].map(slot => slot.next?.promise ?? slot.running))
      }
    },
  }
}
