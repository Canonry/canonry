import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../src/agent/tools.js'

describe('buildTools', () => {
  it('get_evidence reads the latest run detail instead of audit history', async () => {
    const calls: string[] = []
    const client = {
      async getProject() {
        calls.push('getProject')
        return {}
      },
      async listRuns() {
        calls.push('listRuns')
        return [{ id: 'run-1' }, { id: 'run-2' }]
      },
      async getRun(id: string) {
        calls.push(`getRun:${id}`)
        return { id, snapshots: [{ keyword: 'canonry', citationState: 'cited' }] }
      },
      async getHistory() {
        calls.push('getHistory')
        return [{ action: 'project.updated' }]
      },
      async getTimeline() {
        calls.push('getTimeline')
        return []
      },
      async listKeywords() {
        calls.push('listKeywords')
        return []
      },
      async listCompetitors() {
        calls.push('listCompetitors')
        return []
      },
      async triggerRun() {
        calls.push('triggerRun')
        return {}
      },
      async gscPerformance() {
        calls.push('gscPerformance')
        return []
      },
      async gscCoverage() {
        calls.push('gscCoverage')
        return {}
      },
      async gscInspect() {
        calls.push('gscInspect')
        return {}
      },
    }

    const tools = buildTools(client as never, 'canonry')
    const evidence = tools.find((tool) => tool.name === 'get_evidence')
    assert.ok(evidence)

    const result = await evidence.execute({})
    const parsed = JSON.parse(result) as { id: string }

    assert.equal(parsed.id, 'run-2')
    assert.deepEqual(calls, ['listRuns', 'getRun:run-2'])
  })

  it('get_evidence returns an empty shape when the project has no runs yet', async () => {
    const client = {
      async listRuns() {
        return []
      },
      async getRun() {
        throw new Error('should not be called')
      },
    }

    const tools = buildTools(client as never, 'canonry')
    const evidence = tools.find((tool) => tool.name === 'get_evidence')
    assert.ok(evidence)

    const result = await evidence.execute({})
    assert.deepEqual(JSON.parse(result), {
      project: 'canonry',
      latestRun: null,
      snapshots: [],
    })
  })
})
