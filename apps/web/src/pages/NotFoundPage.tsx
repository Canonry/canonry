import { Link } from '@tanstack/react-router'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'

export function NotFoundPage() {
  return (
    <div className="page-container">
      <section className="page-section">
        <Card className="surface-card empty-card">
          <h1>Route not found</h1>
          <p>The current path does not map to a dashboard view.</p>
          <Button asChild>
            <Link to="/">
              Return to overview
            </Link>
          </Button>
        </Card>
      </section>
    </div>
  )
}
