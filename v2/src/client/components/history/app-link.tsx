import { useRouter } from '@tanstack/react-router'
import type { AnchorHTMLAttributes } from 'react'
import { segmentPath } from '~/shared/groups'

/**
 * The editor of an expense or a payment (P-HIST-70: payments open the payment
 * editor), under the group path the user is on. These routes belong to the
 * expenses area; until they exist they fall through to the group's index.
 */
export const expenseHref = (data: { group: string; expenseId: string; kind: 'expense' | 'payment' }) =>
  `${segmentPath(data.group)}/${data.kind === 'payment' ? 'payments' : 'expenses'}/${encodeURIComponent(data.expenseId)}/edit`

/**
 * A link to an app path that is not a typed route yet. A plain click
 * navigates inside the SPA, so it never reloads the page; modified clicks and
 * new tabs keep the browser's behavior.
 */
export function AppLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const router = useRouter()
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return
        event.preventDefault()
        router.history.push(href)
      }}
    />
  )
}
