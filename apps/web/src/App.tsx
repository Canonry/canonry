import { useEffect, useState } from 'react'

const docs = [
  { label: 'Architecture', href: 'https://github.com/AINYC/canonry/blob/main/docs/architecture.md' },
  { label: 'Testing Guide', href: 'https://github.com/AINYC/canonry/blob/main/docs/testing.md' },
  { label: 'Self-Hosting', href: 'https://github.com/AINYC/canonry/blob/main/docs/self-hosting.md' },
]

type StatusState = 'checking' | 'ok' | 'error'

export interface ServiceStatus {
  label: string
  state: StatusState
  detail: string
}

export async function fetchServiceStatus(url: string, label: string): Promise<ServiceStatus> {
  try {
    const response = await fetch(url)

    if (!response.ok) {
      return {
        label,
        state: 'error',
        detail: `HTTP ${response.status}`,
      }
    }

    const payload = (await response.json()) as Record<string, unknown>
    const lastHeartbeatAt = typeof payload.lastHeartbeatAt === 'string' ? `, heartbeat ${payload.lastHeartbeatAt}` : ''
    const version = typeof payload.version === 'string' ? payload.version : 'unknown'

    return {
      label,
      state: 'ok',
      detail: `ok (${version}${lastHeartbeatAt})`,
    }
  } catch (error) {
    return {
      label,
      state: 'error',
      detail: error instanceof Error ? error.message : 'unreachable',
    }
  }
}

export function App() {
  const [apiStatus, setApiStatus] = useState<ServiceStatus>({
    label: 'API',
    state: 'checking',
    detail: 'checking',
  })
  const [workerStatus, setWorkerStatus] = useState<ServiceStatus>({
    label: 'Worker',
    state: 'checking',
    detail: 'checking',
  })

  useEffect(() => {
    let active = true

    const refresh = async () => {
      const [nextApiStatus, nextWorkerStatus] = await Promise.all([
        fetchServiceStatus('/api-health', 'API'),
        fetchServiceStatus('/worker-health', 'Worker'),
      ])

      if (!active) {
        return
      }

      setApiStatus(nextApiStatus)
      setWorkerStatus(nextWorkerStatus)
    }

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 10_000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <main className="shell">
      <div className="eyebrow">AINYC</div>
      <h1>Platform skeleton</h1>
      <p className="lede">
        This repo owns the monitoring product surface. Technical audits are delegated to the published
        <code> @ainyc/aeo-audit </code>
        package from the worker.
      </p>

      <section className="card">
        <h2>Project</h2>
        <p>canonry platform scaffold</p>
      </section>

      <section className="card">
        <h2>Status</h2>
        <p className={`status status-${apiStatus.state}`}>{apiStatus.label} status {apiStatus.detail}</p>
        <p className={`status status-${workerStatus.state}`}>{workerStatus.label} status {workerStatus.detail}</p>
      </section>

      <section className="card">
        <h2>Docs</h2>
        <ul>
          {docs.map((doc) => (
            <li key={doc.href}>
              <a href={doc.href} target="_blank" rel="noreferrer">
                {doc.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
