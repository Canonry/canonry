import { describe, it, expect } from 'vitest'
import { queryKeys } from '../src/queries/query-keys.js'

describe('queryKeys', () => {
  it('projects.all is a stable literal tuple', () => {
    expect(queryKeys.projects.all).toEqual(['projects'])
  })

  it('projects.detail includes project id', () => {
    expect(queryKeys.projects.detail('proj_123')).toEqual(['projects', 'proj_123', undefined])
    expect(queryKeys.projects.detail('proj_123', 'run_abc')).toEqual(['projects', 'proj_123', 'run_abc'])
  })

  it('projects.keywords includes project name', () => {
    expect(queryKeys.projects.keywords('my-project')).toEqual(['projects', 'my-project', 'keywords'])
  })

  it('projects.competitors includes project name', () => {
    expect(queryKeys.projects.competitors('my-project')).toEqual(['projects', 'my-project', 'competitors'])
  })

  it('projects.timeline includes project name and optional location', () => {
    expect(queryKeys.projects.timeline('my-project')).toEqual(['projects', 'my-project', 'timeline', undefined])
    expect(queryKeys.projects.timeline('my-project', 'NYC')).toEqual(['projects', 'my-project', 'timeline', 'NYC'])
  })

  it('runs.all is a stable literal tuple', () => {
    expect(queryKeys.runs.all).toEqual(['runs'])
  })

  it('runs.detail includes run id', () => {
    expect(queryKeys.runs.detail('run_456')).toEqual(['runs', 'run_456'])
  })

  it('settings is a stable literal tuple', () => {
    expect(queryKeys.settings).toEqual(['settings'])
  })

  it('health is a stable literal tuple', () => {
    expect(queryKeys.health).toEqual(['health'])
  })

  it('gsc keys scope by project name', () => {
    expect(queryKeys.gsc.performance('my-project')).toEqual(['gsc', 'my-project', 'performance'])
    expect(queryKeys.gsc.inspections('my-project')).toEqual(['gsc', 'my-project', 'inspections'])
    expect(queryKeys.gsc.deindexed('my-project')).toEqual(['gsc', 'my-project', 'deindexed'])
    expect(queryKeys.gsc.coverage('my-project')).toEqual(['gsc', 'my-project', 'coverage'])
    expect(queryKeys.gsc.coverageHistory('my-project')).toEqual(['gsc', 'my-project', 'coverage-history'])
    expect(queryKeys.gsc.sitemaps('my-project')).toEqual(['gsc', 'my-project', 'sitemaps'])
  })

  it('gsc.connections and gsc.properties are stable literal tuples', () => {
    expect(queryKeys.gsc.connections).toEqual(['gsc', 'connections'])
    expect(queryKeys.gsc.properties).toEqual(['gsc', 'properties'])
  })

  it('schedule and notifications scope by project name', () => {
    expect(queryKeys.schedule('my-project')).toEqual(['schedule', 'my-project'])
    expect(queryKeys.notifications('my-project')).toEqual(['notifications', 'my-project'])
  })

  it('different project ids produce distinct keys', () => {
    const key1 = queryKeys.projects.detail('proj_a')
    const key2 = queryKeys.projects.detail('proj_b')
    expect(key1).not.toEqual(key2)
  })
})
