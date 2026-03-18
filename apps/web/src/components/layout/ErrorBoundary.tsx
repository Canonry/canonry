import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '../ui/button.js'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ error: null })
  }

  override render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="page-container">
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="rounded-full bg-rose-950/40 p-3">
            <AlertTriangle className="size-6 text-rose-400" />
          </div>
          <h2 className="text-lg font-semibold text-zinc-100">Something went wrong</h2>
          <p className="text-sm text-zinc-400 max-w-md">
            {this.state.error.message || 'An unexpected error occurred while rendering this page.'}
          </p>
          <div className="flex gap-3 mt-2">
            <Button variant="secondary" size="sm" onClick={this.handleReset}>
              <RotateCcw className="size-3.5 mr-1.5" />
              Try again
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { window.location.href = '/' }}>
              Go home
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
