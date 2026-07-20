import { AuditHistoryPanel } from '../components/shared/AuditHistoryPanel.js'

export function HistoryPage() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">History</h1>
          <p className="page-subtitle">Instance-wide configuration changes, including retained evidence for deleted projects.</p>
        </div>
      </div>
      <AuditHistoryPanel />
    </div>
  )
}
