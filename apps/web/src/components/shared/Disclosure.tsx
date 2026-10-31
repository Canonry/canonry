import type { ReactNode } from 'react'

/**
 * "Details ▸": the fine print under an AI Visibility card, as bullets.
 * Always starts closed so the card reads as its title, number grid and status
 * words; everything else waits here. Native <details> keeps the toggle a real
 * button with browser-managed state, and closed bullets stay out of the tab
 * order. Renders nothing when there is nothing to disclose.
 */
export function Disclosure({ items, label = 'Details' }: { items: readonly ReactNode[]; label?: string }) {
  if (items.length === 0) return null
  return (
    <details className="av-details">
      <summary>{label}</summary>
      <ul className="av-details-list">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </details>
  )
}
