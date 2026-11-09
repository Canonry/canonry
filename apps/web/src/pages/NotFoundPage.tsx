import { Link } from '@tanstack/react-router'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'

export function NotFoundPage() {
  return (
    <div className="page-container">
      <section className="page-section">
        <Card className="surface-card empty-card">
          <h1>Page not found</h1>
          <p>This page may have moved. Choose a project to continue.</p>
          <Button asChild>
            <Link to="/projects">
              View projects
            </Link>
          </Button>
        </Card>
      </section>
    </div>
  )
}
