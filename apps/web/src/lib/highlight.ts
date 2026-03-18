import type { ReactNode } from 'react'
import React from 'react'

export function highlightTermsInText(text: string, terms: string[]): ReactNode[] {
  const nonEmpty = terms.filter(t => t.trim().length > 1)

  // Step 1: parse **bold** spans into typed segments
  type Segment = { type: 'text' | 'bold'; value: string }
  const segments: Segment[] = text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(seg => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return { type: 'bold' as const, value: seg.slice(2, -2) }
    }
    return { type: 'text' as const, value: seg }
  })

  if (nonEmpty.length === 0) {
    return segments.map((seg, i) =>
      seg.type === 'bold'
        ? React.createElement('strong', { key: `b-${i}`, className: 'text-zinc-200 font-semibold' }, seg.value)
        : seg.value,
    ).filter(Boolean) as ReactNode[]
  }

  // Step 2: within each segment, split on highlight terms
  const escaped = nonEmpty.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')

  return segments.flatMap((seg, si) => {
    const parts = seg.value.split(regex)
    return parts.map((part, pi) => {
      if (!part) return null
      const isMatch = pi % 2 === 1
      if (isMatch) {
        return seg.type === 'bold'
          ? React.createElement('mark', { key: `hl-${si}-${pi}`, className: 'answer-highlight' },
              React.createElement('strong', { className: 'text-zinc-200 font-semibold' }, part))
          : React.createElement('mark', { key: `hl-${si}-${pi}`, className: 'answer-highlight' }, part)
      }
      return seg.type === 'bold'
        ? React.createElement('strong', { key: `b-${si}-${pi}`, className: 'text-zinc-200 font-semibold' }, part)
        : part
    })
  }).filter(Boolean) as ReactNode[]
}
