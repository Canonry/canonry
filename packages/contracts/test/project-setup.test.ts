import { describe, expect, it } from 'vitest'
import { runStatusSchema } from '../src/run.js'
import {
  AiVisibilitySetupBlockers,
  ProjectSetupNextActions,
  SetupTrackStates,
  setupTrackStateSchema,
} from '../src/project-setup.js'

// The dashboard, the CLI and MCP clients are written against these exact wire values.
describe('project setup vocabulary', () => {
  it('reads a track as a run status, plus not_started for a track with no run, and nothing else', () => {
    expect(setupTrackStateSchema.options).toEqual(['not_started', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled'])
    // A run status a later release adds becomes a track state with it.
    for (const status of runStatusSchema.options) expect(setupTrackStateSchema.safeParse(status).success, status).toBe(true)
    expect(runStatusSchema.safeParse(SetupTrackStates.not_started).success).toBe(false)
    // Skipping a track is never a state: it stays not_started.
    expect(setupTrackStateSchema.safeParse('skipped').success).toBe(false)
  })

  it('names every blocker and next action through its constants object', () => {
    expect(SetupTrackStates).toEqual({
      not_started: 'not_started', queued: 'queued', running: 'running', completed: 'completed',
      partial: 'partial', failed: 'failed', cancelled: 'cancelled',
    })
    expect(AiVisibilitySetupBlockers).toEqual({
      no_engine: 'no_engine', no_queries: 'no_queries', plan_unpublished: 'plan_unpublished', engines_failing: 'engines_failing',
    })
    expect(ProjectSetupNextActions).toEqual({
      run_agent_readiness: 'run_agent_readiness',
      retry_agent_readiness: 'retry_agent_readiness',
      connect_engine: 'connect_engine',
      add_queries: 'add_queries',
      publish_plan: 'publish_plan',
      run_ai_visibility: 'run_ai_visibility',
      repair_ai_visibility: 'repair_ai_visibility',
      wait: 'wait',
      open_project: 'open_project',
    })
  })
})
