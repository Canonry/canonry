import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { appHref } from '../lib/base-path.js'

function createNavigationHandler(navigate: (to: string) => void, to: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault()
    navigate(to)
  }
}

export function NotFoundPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <div className="page-container">
      <section className="page-section">
        <Card className="surface-card empty-card">
          <h1>Route not found</h1>
          <p>The current path does not map to a dashboard view.</p>
          <Button asChild>
            <a href={appHref('/')} onClick={createNavigationHandler(onNavigate, '/')}>
              Return to overview
            </a>
          </Button>
        </Card>
      </section>
    </div>
  )
}
