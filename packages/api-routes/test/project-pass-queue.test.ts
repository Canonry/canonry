import { describe, expect, it } from 'vitest'
import { createProjectPassQueue } from '../src/project-pass-queue.js'

/** A pass the test finishes by hand, recording when each one started. */
function controlledPasses() {
  const started: string[] = []
  const finishers: Array<(value: string) => void> = []
  const failers: Array<(error: Error) => void> = []
  const run = (projectId: string) => new Promise<string>((resolve, reject) => {
    const pass = `${projectId}#${started.filter(entry => entry.startsWith(projectId)).length + 1}`
    started.push(pass)
    finishers.push(() => resolve(pass))
    failers.push(reject)
  })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  return { started, run, finish: (index: number) => finishers[index]!(''), fail: (index: number, error: Error) => failers[index]!(error), tick }
}

describe('createProjectPassQueue', () => {
  it('coalesces a burst into the running pass and ONE follow-up that starts after it', async () => {
    const passes = controlledPasses()
    const queue = createProjectPassQueue(passes.run)
    const first = queue.request('acme')
    const during = [queue.request('acme'), queue.request('acme'), queue.request('acme')]
    expect(passes.started).toEqual(['acme#1'])

    passes.finish(0)
    await expect(first).resolves.toBe('acme#1')
    await passes.tick()
    // Requests made while pass 1 ran never receive its result.
    expect(passes.started).toEqual(['acme#1', 'acme#2'])
    passes.finish(1)
    await expect(Promise.all(during)).resolves.toEqual(['acme#2', 'acme#2', 'acme#2'])
    await queue.settled()
    expect(passes.started).toHaveLength(2)
  })

  it('lets a dry-run queue join the pass under way', async () => {
    const passes = controlledPasses()
    const queue = createProjectPassQueue(passes.run, { joinRunning: true })
    const both = [queue.request('acme'), queue.request('acme')]
    passes.finish(0)
    await expect(Promise.all(both)).resolves.toEqual(['acme#1', 'acme#1'])
    expect(passes.started).toEqual(['acme#1'])
  })

  it('runs projects independently and rejects only the callers of a failed pass', async () => {
    const passes = controlledPasses()
    const queue = createProjectPassQueue(passes.run)
    const acme = queue.request('acme')
    const zenith = queue.request('zenith')
    expect(passes.started).toEqual(['acme#1', 'zenith#1'])
    passes.fail(0, new Error('scan failed'))
    await expect(acme).rejects.toThrow('scan failed')
    passes.finish(1)
    await expect(zenith).resolves.toBe('zenith#1')

    // The failure leaves nothing behind: the next request starts a new pass.
    const retry = queue.request('acme')
    expect(passes.started).toEqual(['acme#1', 'zenith#1', 'acme#2'])
    passes.finish(2)
    await expect(retry).resolves.toBe('acme#2')
    await queue.settled()
  })
})
