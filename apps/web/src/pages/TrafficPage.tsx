import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { heyClient, type ApiProject } from '../api.js'
import { getApiV1ProjectsOptions } from '@canonry/canonry-api-client/react-query'
import { Card } from '../components/ui/card.js'
import { ServerTrafficSection } from '../components/project/ServerTrafficSection.js'

export function TrafficPage() {
  const [selectedProject, setSelectedProject] = useState<string>('')

  const projectsQuery = useQuery(getApiV1ProjectsOptions({ client: heyClient }))
  const projects: ApiProject[] = projectsQuery.data ?? []

  const activeProject = useMemo(() => {
    if (selectedProject) return selectedProject
    return projects[0]?.name ?? ''
  }, [selectedProject, projects])

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Traffic sources</h1>
          <p className="page-subtitle">
            AI crawler hits and referral sessions from your server logs.
          </p>
        </div>
      </div>

      <section>
        {projects.length > 1 && (
          <label className="mb-4 flex w-fit items-center gap-2 text-label-14-strong text-secondary" htmlFor="traffic-project">
            Project
            <select
              id="traffic-project"
              className="h-8 min-w-44 rounded-md border border-base bg-bg px-2 text-label-14 text-heading outline-none transition focus:border-mono-500 focus:ring-1 focus:ring-mono-500"
              value={activeProject}
              onChange={(event) => setSelectedProject(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.name}>
                  {project.displayName ?? project.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {!activeProject ? (
          <Card className="p-6 text-center text-label-14 text-muted">No projects yet.</Card>
        ) : (
          <ServerTrafficSection projectName={activeProject} heading={false} />
        )}
      </section>
    </div>
  )
}
