import ReactMarkdown from 'react-markdown'
import { safeExternalUrl } from '../../lib/safe-url.js'

export function AnswerMarkdown({ children }: { children: string }) {
  return (
    <div className="answer-markdown">
      <ReactMarkdown components={{
        p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>,
        pre: ({ children }) => <pre className="mb-3 overflow-x-auto whitespace-pre-wrap">{children}</pre>,
        a: ({ children, href }) => {
          const safeHref = safeExternalUrl(href)
          return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer" className="text-link underline">{children}</a> : <span>{children}</span>
        },
        img: ({ alt }) => <span>{alt}</span>,
      }}>{children}</ReactMarkdown>
    </div>
  )
}
