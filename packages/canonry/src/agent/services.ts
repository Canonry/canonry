/**
 * Agent services — direct DB operations for agent tools.
 * 
 * Provides the same functionality as the HTTP API routes but without
 * the circular dependency of calling the server's own HTTP endpoints.
 */

import type { DatabaseClient } from '@ainyc/canonry-db'
import { 
  projects,
  keywords as keywordsTable,
  competitors as competitorsTable,
  runs as runsTable,
  querySnapshots,
} from '@ainyc/canonry-db'
import { eq, desc, and, inArray } from 'drizzle-orm'

export class AgentServices {
  constructor(private db: DatabaseClient) {}

  async getProject(projectName: string) {
    const project = this.db
      .select()
      .from(projects)
      .where(eq(projects.name, projectName))
      .get()
    
    if (!project) {
      throw new Error(`Project ${projectName} not found`)
    }
    
    return project
  }

  async listRuns(projectName: string) {
    const project = await this.getProject(projectName)
    
    return this.db
      .select()
      .from(runsTable)
      .where(eq(runsTable.projectId, project.id))
      .orderBy(desc(runsTable.createdAt))
      .all()
  }

  async getRun(runId: string, projectName: string) {
    const project = await this.getProject(projectName)

    const run = this.db
      .select()
      .from(runsTable)
      .where(and(eq(runsTable.id, runId), eq(runsTable.projectId, project.id)))
      .get()

    if (!run) {
      throw new Error(`Run ${runId} not found in project ${projectName}`)
    }

    const snapshots = this.db
      .select()
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, runId))
      .all()

    return { ...run, snapshots }
  }

  async listKeywords(projectName: string) {
    const project = await this.getProject(projectName)
    
    return this.db
      .select()
      .from(keywordsTable)
      .where(eq(keywordsTable.projectId, project.id))
      .all()
  }

  async listCompetitors(projectName: string) {
    const project = await this.getProject(projectName)
    
    return this.db
      .select()
      .from(competitorsTable)
      .where(eq(competitorsTable.projectId, project.id))
      .all()
  }

  async getHistory(projectName: string) {
    const project = await this.getProject(projectName)
    
    // Get recent runs with snapshots
    const runs = this.db
      .select()
      .from(runsTable)
      .where(eq(runsTable.projectId, project.id))
      .orderBy(desc(runsTable.createdAt))
      .limit(10)
      .all()
    
    if (runs.length === 0) {
      return { project, runs: [], evidence: {} }
    }
    
    // Get all snapshots for these runs
    const runIds = runs.map(r => r.id)
    const snapshots = this.db
      .select()
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, runIds))
      .all()

    return {
      project,
      runs,
      snapshots,
    }
  }

  async getTimeline(projectName: string) {
    const project = await this.getProject(projectName)
    
    // Get all runs
    const runs = this.db
      .select()
      .from(runsTable)
      .where(eq(runsTable.projectId, project.id))
      .orderBy(desc(runsTable.createdAt))
      .all()
    
    // Aggregate citation data by run
    const timeline = runs.map(run => {
      const snapshots = this.db
        .select()
        .from(querySnapshots)
        .where(eq(querySnapshots.runId, run.id))
        .all()
      
      const cited = snapshots.filter(s => s.citationState === 'cited').length
      const total = snapshots.length
      
      return {
        runId: run.id,
        createdAt: run.createdAt,
        status: run.status,
        cited,
        total,
        rate: total > 0 ? cited / total : 0,
      }
    })
    
    return { project, timeline }
  }
}
