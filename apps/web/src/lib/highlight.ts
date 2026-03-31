import type { ReactNode } from 'react'
import React from 'react'

export interface HighlightTermGroup {
  terms: string[]
  className: string
}

export function highlightTermsInText(text: string, terms: string[] | HighlightTermGroup[]): ReactNode[] {
  // Normalize to term groups
  const groups: HighlightTermGroup[] = normalizeTermGroups(terms)

  // Step 1: parse **bold** spans into typed segments
  type Segment = { type: 'text' | 'bold'; value: string }
  const segments: Segment[] = text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(seg => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return { type: 'bold' as const, value: seg.slice(2, -2) }
    }
    return { type: 'text' as const, value: seg }
  })

  // Collect all non-empty terms across all groups
  const allTerms = groups.flatMap(g => g.terms).filter(t => t.trim().length > 1)
  if (allTerms.length === 0) {
    return segments.map((seg, i) =>
      seg.type === 'bold'
        ? React.createElement('strong', { key: `b-${i}`, className: 'text-zinc-200 font-semibold' }, seg.value)
        : seg.value,
    ).filter(Boolean) as ReactNode[]
  }

  // Build a single regex from all terms (longest first to avoid partial matches)
  const sorted = [...allTerms].sort((a, b) => b.length - a.length)
  const escaped = sorted.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')

  // Build a lookup: lowercase term → className (first group wins)
  const termClassMap = new Map<string, string>()
  for (const group of groups) {
    for (const term of group.terms) {
      const key = term.toLowerCase()
      if (!termClassMap.has(key)) {
        termClassMap.set(key, group.className)
      }
    }
  }

  return segments.flatMap((seg, si) => {
    const parts = seg.value.split(regex)
    return parts.map((part, pi) => {
      if (!part) return null
      const isMatch = pi % 2 === 1
      if (isMatch) {
        const cls = termClassMap.get(part.toLowerCase()) ?? 'answer-highlight'
        return seg.type === 'bold'
          ? React.createElement('mark', { key: `hl-${si}-${pi}`, className: cls },
              React.createElement('strong', { className: 'text-zinc-200 font-semibold' }, part))
          : React.createElement('mark', { key: `hl-${si}-${pi}`, className: cls }, part)
      }
      return seg.type === 'bold'
        ? React.createElement('strong', { key: `b-${si}-${pi}`, className: 'text-zinc-200 font-semibold' }, part)
        : part
    })
  }).filter(Boolean) as ReactNode[]
}

function normalizeTermGroups(input: string[] | HighlightTermGroup[]): HighlightTermGroup[] {
  if (input.length === 0) return []
  if (typeof input[0] === 'string') {
    return [{ terms: input as string[], className: 'answer-highlight' }]
  }
  return input as HighlightTermGroup[]
}
