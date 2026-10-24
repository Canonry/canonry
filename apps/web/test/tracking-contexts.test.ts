import { describe, expect, test } from 'vitest'
import type { QueryTrackingWorkspaceResponse } from '@canonry/canonry-contracts'

import { contextChoices, plannedContext, sheetContextChoices } from '../src/components/project/queries/tracking-contexts.js'
import { defaultTrackingDraft } from '../src/components/project/queries/tracking-draft.js'

// The search location and engines a new query is offered: what the plan's rows are asked with, ahead of the project's own setting.

type Workspace = Pick<QueryTrackingWorkspaceResponse, 'defaultContexts' | 'tracked'>
type Context = Workspace['defaultContexts'][number]

const place = (label: string) => ({ label, city: label, region: 'IL', country: 'US' })
const asked = (providers: string[], location: string | null = null, models: Record<string, string> = {}): Context =>
  ({ providers, models, location: location === null ? null : place(location) })
/** One tracked row per list of search locations, each list one location link. */
function workspace(defaults: Context[], ...links: Context[][]): Workspace {
  return {
    defaultContexts: defaults,
    tracked: links.map((contexts, index) => ({
      queryId: `query-${index}`, queryText: `query ${index}`, normalizedText: `query ${index}`, provenance: null,
      state: 'tracked', lastMeasuredAt: null,
      assignments: [{ targetKey: `location-${index}`, groupKeys: [], marketKeys: [], queryClass: 'non-brand', classificationSource: 'server', contexts }],
    })),
  }
}
const THREE = asked(['claude', 'gemini', 'openai'])
const TWO = asked(['gemini', 'openai'])
const SELECTION = { measurementScope: 'project', measurementScopeKey: undefined, queryClass: 'all' } as const

describe('contextChoices', () => {
  test('offers what the plan is asked with ahead of the project\'s own setting, each engine by its display name', () => {
    // The plan was published on three engines and the project is now set to two: a query added beside the plan's rows is offered the three first.
    const choices = contextChoices(workspace([TWO], [THREE], [THREE], [THREE]))
    expect(choices).toEqual([
      { label: 'No search location · Claude, Gemini, OpenAI', detail: 'No search location · claude, gemini, openai', input: { providers: ['claude', 'gemini', 'openai'], models: {}, location: null } },
      { label: 'No search location · Gemini, OpenAI', detail: 'No search location · gemini, openai', input: { providers: ['gemini', 'openai'], models: {}, location: null } },
    ])
  })

  test('lists a choice once when the plan and the project agree, whatever order its engines are stored in', () => {
    const choices = contextChoices(workspace([asked(['openai', 'gemini'], 'Lakeshore')], [asked(['gemini', 'openai'], 'Lakeshore')]))
    // Kept as the plan stores it.
    expect(choices.map(choice => choice.label)).toEqual(['Lakeshore · Gemini, OpenAI'])
  })

  test('puts the search location and engines most of the plan is asked with first', () => {
    const uptown = asked(['openai'], 'Uptown')
    const harbor = asked(['openai'], 'Harbor')
    const choices = contextChoices(workspace([asked(['openai'], 'Harbor'), asked(['openai'], 'Lakeshore'), asked(['openai'], 'Uptown')], [harbor], [uptown], [uptown, harbor], [uptown]))
    // Uptown three times, Harbor twice, then the one the plan does not use.
    expect(choices.map(choice => choice.label)).toEqual(['Uptown · OpenAI', 'Harbor · OpenAI', 'Lakeshore · OpenAI'])
  })

  test('leaves out a search location the project no longer has: the server would refuse a query asked from it', () => {
    // The plan still asks from Old Harbor. The project is now set to Lakeshore alone.
    const choices = contextChoices(workspace([asked(['openai'], 'Lakeshore')], [asked(['openai'], 'Old Harbor')], [asked(['openai', 'gemini'])]))
    // No search location is always one a query can be asked from.
    expect(choices.map(choice => choice.label)).toEqual(['No search location · OpenAI, Gemini', 'Lakeshore · OpenAI'])
  })

  test('keeps the model ids on two choices that read alike by display name', () => {
    const choices = contextChoices(workspace([asked(['openai'], 'Lakeshore', { openai: 'model-a' })], [asked(['openai'], 'Lakeshore', { openai: 'model-b' })]))
    expect(choices.map(choice => choice.label)).toEqual(['Lakeshore · openai (model-b)', 'Lakeshore · openai (model-a)'])
    // One that reads like no other is named plainly, with its model behind the name.
    expect(contextChoices(workspace([asked(['openai'], 'Lakeshore', { openai: 'model-a' })]))).toMatchObject([{ label: 'Lakeshore · OpenAI', detail: 'Lakeshore · openai (model-a)' }])
  })

  test('lists a choice a form already holds last, named like the rest', () => {
    const held = { providers: ['openai'], models: { openai: 'model-a' }, location: 'Midtown' }
    const choices = contextChoices(workspace([TWO], [THREE]), [held, { providers: ['openai', 'gemini'], models: {}, location: null }])
    // The second is the project's own setting in another engine order: it is not listed twice.
    expect(choices.map(choice => choice.label)).toEqual(['No search location · Claude, Gemini, OpenAI', 'No search location · Gemini, OpenAI', 'Midtown · OpenAI'])
    expect(choices[2]!.input).toBe(held)
  })

  test('has nothing to offer a project with no engines set up and no plan', () => {
    expect(contextChoices(workspace([]))).toEqual([])
  })
})

describe('sheetContextChoices', () => {
  test('labels a lone choice with the form\'s own words, which a sheet keeps behind the name it draws', () => {
    expect(sheetContextChoices(workspace([asked(['openai'], 'Lakeshore', { openai: 'model-a' })]))).toEqual([
      { label: 'Lakeshore · openai (model-a)', input: { providers: ['openai'], models: { openai: 'model-a' }, location: 'Lakeshore' } },
    ])
  })

  test('labels several by name, the plan\'s first, for a select', () => {
    expect(sheetContextChoices(workspace([TWO], [THREE])).map(choice => choice.label)).toEqual(['No search location · Claude, Gemini, OpenAI', 'No search location · Gemini, OpenAI'])
  })
})

describe('the choice a form for a new query opens on', () => {
  test('is the plan\'s own when every row of the plan is asked one way, though the project\'s setting lists fewer engines', () => {
    const plan = workspace([TWO], [THREE], [THREE])
    expect(plannedContext(plan)).toEqual({ providers: ['claude', 'gemini', 'openai'], models: {}, location: null })
    expect(defaultTrackingDraft(SELECTION, plan).contexts).toEqual([{ providers: ['claude', 'gemini', 'openai'], models: {}, location: null }])
  })

  test('is left open when the plan is asked several ways, has no rows, or asks only from a search location the project no longer has', () => {
    for (const plan of [workspace([TWO], [THREE], [TWO]), workspace([TWO]), workspace([asked(['openai'], 'Lakeshore')], [asked(['openai'], 'Old Harbor')])]) {
      expect(plannedContext(plan)).toBeUndefined()
      expect(defaultTrackingDraft(SELECTION, plan).contexts).toEqual([])
    }
  })

  test('is left open by a draft made without the workspace, as an edit\'s is', () => {
    expect(defaultTrackingDraft(SELECTION).contexts).toEqual([])
  })
})
