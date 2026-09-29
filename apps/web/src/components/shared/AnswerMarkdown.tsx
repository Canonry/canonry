import { Fragment, memo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { highlightTermsInText, type HighlightTermGroup } from '../../lib/highlight.js'
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
  value?: string
  alt?: string
  children?: MarkdownNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function prepareAnswerPreview({ previewLength, highlight }: { previewLength?: number; highlight: boolean }) {
  return (tree: MarkdownNode) => {
    if (previewLength !== undefined && Number.isFinite(previewLength)) {
      let remaining = Math.max(0, Math.floor(previewLength))
      const preview: { lastNode?: MarkdownNode; field: 'value' | 'alt'; omitted: boolean } = { field: 'value', omitted: false }
      const trim = (node: MarkdownNode): boolean => {
        // Definitions may follow omitted prose; retained reference links still need them.
        if (node.type === 'definition') return true
        if (node.children) {
          node.children = node.children.filter(trim)
          return node.children.length > 0
        }
        const field = node.type === 'image' || node.type === 'imageReference' ? 'alt' : 'value'
        const value = node[field]
        if (value === undefined) return remaining > 0
        const characters = Array.from(value)
        if (characters.length === 0) return remaining > 0
        if (remaining === 0) {
          preview.omitted = true
          return false
        }
        const overBudget = characters.length > remaining
        const kept = characters.slice(0, remaining)
        if (overBudget && !/\s/.test(characters[remaining]!)) {
          let wordBoundary = kept.length - 1
          while (wordBoundary >= 0 && !/\s/.test(kept[wordBoundary]!)) wordBoundary--
          if (wordBoundary >= 0 && wordBoundary > remaining - 40) kept.length = wordBoundary
        }
        preview.omitted ||= overBudget
        node[field] = kept.join('')
        remaining = overBudget ? 0 : remaining - kept.length
        if (kept.length === 0) return false
        preview.lastNode = node
        preview.field = field
        return true
      }
      trim(tree)
      if (preview.omitted) {
        if (preview.lastNode) preview.lastNode[preview.field] = `${preview.lastNode[preview.field]!.trimEnd()}…`
        else tree.children?.push({ type: 'paragraph', children: [{ type: 'text', value: '…' }] })
      }
    }
    if (highlight) {
      const markProse = (node: MarkdownNode) => {
        if (['link', 'linkReference', 'code', 'inlineCode'].includes(node.type)) return
        if (node.type === 'text') node.data = { ...node.data, hName: 'span' }
        node.children?.forEach(markProse)
      }
      markProse(tree)
    }
  }
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

export const AnswerMarkdown = memo(function AnswerMarkdown({ children, headingLevel = 4, copyable = false, highlightGroups, previewLength }: {
  children: string
  /** The shallowest answer heading, below the containing page section. */
  headingLevel?: 2 | 3 | 4 | 5 | 6
  copyable?: boolean
  highlightGroups?: HighlightTermGroup[]
  /** Parsed text limit, excluding Markdown syntax and URLs; keeps nearby whole words. */
  previewLength?: number
}) {
  return (
    <div className="answer-markdown">
      <ReactMarkdown remarkPlugins={[[rebaseAnswerHeadings, { headingLevel }], [prepareAnswerPreview, { previewLength, highlight: Boolean(highlightGroups?.length) }]]} components={{
        p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>,
        ol: ({ children, start }) => <ol start={start} className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>,
        pre: ({ children }) => <pre className="mb-3 overflow-x-auto whitespace-pre-wrap">{children}</pre>,
        span: ({ children }) => <span>{typeof children === 'string' && highlightGroups
          ? children.split(/(https?:\/\/[^\s<>]+)/i).map((text, index) => index % 2
            ? text
            : <Fragment key={index}>{highlightTermsInText(text, highlightGroups)}</Fragment>)
          : children}</span>,
        a: ({ children, href }) => {
          const safeHref = safeExternalUrl(href)
          return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer" className="text-link underline">{children}</a> : <span>{children}</span>
        },
        img: ({ alt }) => <span>{alt}</span>,
      }}>{children}</ReactMarkdown>
      {copyable && children.trim() ? <CopyAnswerButton key={children} answer={children} /> : null}
    </div>
  )
})
