/**
 * Three small pieces for the places where a view-only account meets something it
 * cannot do.
 *
 * None is a security boundary: the server refuses the same request with or
 * without them. They exist so that a person with view-only access is told what
 * their account can do, in the place where it matters, instead of filling in a
 * form and being refused at the end of it.
 */
import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'

import { useAccount, VIEW_ONLY_LABEL } from '../../contexts/account-context.js'
import { Button, type ButtonProps } from '../ui/button.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'
import { StatusNote } from './StatusNote.js'

/**
 * A button for an action that changes something.
 *
 * Behaves exactly like `Button` for an administrator, and for an install with
 * no accounts at all. For a viewer it is switched off and carries the reason,
 * so hovering explains it rather than leaving a dead control.
 */
export function WriteButton({ disabled, title, ...props }: ButtonProps) {
  const { canWrite } = useAccount()
  if (canWrite) return <Button disabled={disabled} title={title} {...props} />
  return <Button {...props} disabled title={VIEW_ONLY_LABEL} />
}

/**
 * What a view-only account reads where a section's write controls would be:
 * two words, with the sentence behind them. The section draws it in place of
 * those controls, so nothing is left to press and be refused.
 */
export function ViewOnlyNote() {
  return <StatusNote icon={Lock} label="View only" detail="Your account cannot change this." />
}

/**
 * A whole screen only an administrator can use.
 *
 * A viewer gets a plain explanation in its place — not an error, and not a
 * blank page that looks like something broke.
 */
export function AdminOnly({ title, children }: { title: string; children: ReactNode }) {
  const { isAdmin } = useAccount()
  if (isAdmin) return <>{children}</>

  return (
    <Card className="surface-card mx-auto mt-8 max-w-lg">
      <CardHeader>
        <CardTitle>{title} is for administrators</CardTitle>
        <CardDescription>
          Your account has view-only access. You can read everything this install has measured;
          changing how it is set up needs an administrator account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="supporting-copy">
          If you need to make a change here, ask an administrator on this install.
        </p>
      </CardContent>
    </Card>
  )
}
