import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { safeExternalUrl } from '../../lib/safe-url.js'
import { Button } from '../ui/button.js'

export const ANSWER_SOURCES_LABEL = 'Sources'
export const ANSWER_MARKDOWN_COPY = {
  copy: 'Copy answer',
  copying: 'Copying…',
  copied: 'Copied',
  failed: 'Could not copy. Select and copy the answer above.',
} as const

interface MarkdownNode {
  type: string
  depth?: number
  children?: MarkdownNode[]
  data?: { hProperties?: Record<string, unknown> }
}

function rebaseAnswerHeadings({ headingLevel }: { headingLevel: number }) {
  return (tree: MarkdownNode) => {
    const headings: MarkdownNode[] = []
    const collectHeadings = (node: MarkdownNode) => {
      if (node.type === 'heading' && node.depth) headings.push(node)
      node.children?.forEach(collectHeadings)
    }
    collectHeadings(tree)
    const shallowest = headings.reduce((level, node) => Math.min(level, node.depth!), 6)
    for (const heading of headings) {
      const relativeLevel = heading.depth! - shallowest
      heading.depth = Math.min(6, headingLevel + relativeLevel)
      heading.data = {
        ...heading.data,
        hProperties: { ...heading.data?.hProperties, 'data-answer-heading-level': relativeLevel + 1 },
      }
    }
  }
}

function CopyAnswerButton({ answer }: { answer: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const copying = useRef(false)
  const copyAnswer = async () => {
    if (copying.current) return
    copying.current = true
    setState('copying')
    try {
      await navigator.clipboard.writeText(answer)
      setState('copied')
    } catch {
      setState('failed')
    } finally {
      copying.current = false
    }
  }
  return <div className="mt-3 flex flex-wrap items-center gap-x-3">
    <Button type="button" variant="ghost" className="min-h-11 px-2" aria-disabled={state === 'copying'} aria-busy={state === 'copying'} onClick={() => { void copyAnswer() }}>
      {state === 'copying' ? ANSWER_MARKDOWN_COPY.copying : ANSWER_MARKDOWN_COPY.copy}
    </Button>
    <span role="status" className="text-sm text-secondary">{state === 'copied' ? ANSWER_MARKDOWN_COPY.copied : state === 'failed' ? ANSWER_MARKDOWN_COPY.failed : ''}</span>
  </div>
}

export function AnswerMarkdown({ children, headingLevel = 4, copyable = false }: {
  children: string
  /** The shallowest answer heading, below the containing page section. */
  headingLevel?: 2 | 3 | 4 | 5 | 6
  copyable?: boolean
}) {
  return (
    <div className="answer-markdown">
      <ReactMarkdown remarkPlugins={[[rebaseAnswerHeadings, { headingLevel }]]} components={{
        p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>,
        ol: ({ children, start }) => <ol start={start} className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>,
        pre: ({ children }) => <pre className="mb-3 overflow-x-auto whitespace-pre-wrap">{children}</pre>,
        a: ({ children, href }) => {
          const safeHref = safeExternalUrl(href)
          return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer" className="text-link underline">{children}</a> : <span>{children}</span>
        },
        img: ({ alt }) => <span>{alt}</span>,
      }}>{children}</ReactMarkdown>
      {copyable && children.trim() ? <CopyAnswerButton key={children} answer={children} /> : null}
    </div>
  )
}
