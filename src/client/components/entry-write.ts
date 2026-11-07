// Saving and deleting an expense or a payment, for both forms. A target says
// where the entry lives, how it saves, how to find out whether it exists, and
// where the form goes afterwards; the forms never branch on the page they are on.
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { editorLink } from '~/client/editor-link'
import { describeError, type Failure } from '~/client/errors'
import { afterWrite } from '~/client/queries/keys'
import { newIdempotencyKey, rpc } from '~/client/rpc'
import type { ExpenseDraft, ResolvedExpense } from '~/shared/expense-rules'
import { formatMinor, type Minor } from '~/shared/minor'
import type { ExpenseKind } from '~/shared/vocabulary'
import type { FormDocument } from './expense-documents'

/** The RPC payload of a draft and what validateExpense resolved from it: the amounts as exact decimals. */
export function toInput(data: { draft: ExpenseDraft; resolved: ResolvedExpense; documents: readonly FormDocument[] }) {
  const { draft, resolved } = data
  const text = (amount: Minor) => formatMinor({ amount, currency: draft.currency })
  return {
    ...draft,
    amount: text(resolved.amount),
    payers: resolved.payers.map((p) => ({ participantId: p.participantId, amount: text(p.amount) })),
    documents: data.documents.map((d) => ({ id: d.id, url: d.url, width: d.width, height: d.height })),
  }
}

type ExpenseInput = ReturnType<typeof toInput>

/** A new entry with the ID its form minted when it opened (P-EXP-38), or a saved one at the revision the form loaded. */
export type Entry = { readonly mode: 'create'; readonly expenseId: string } | { readonly mode: 'edit'; readonly expenseId: string; readonly revision: number }

/** Where Cancel goes. */
type BackLink =
  | { readonly to: '/' }
  | { readonly to: '/expenses/$expenseId'; readonly params: { readonly expenseId: string } }
  | { readonly to: '/$group/expenses' | '/$group/payments'; readonly params: { readonly group: string } }

export type EntryTarget = {
  /** The group or private context that stores the entry and its receipts; null until a new ungrouped expense is saved. */
  readonly groupId: string | null
  /** The current app's options for an ungrouped expense (P-UNGROUP-66, P-UNGROUP-67). */
  readonly privateExpense: boolean
  readonly back: BackLink
  /** Creates or updates the entry; rejects with an RpcError. */
  readonly save: (data: { entry: Entry; expense: ExpenseInput; idempotencyKey: string }) => Promise<void>
  /** Whether the entry exists now, after a create failed. */
  readonly exists: (expenseId: string) => Promise<boolean>
  /** After a save or a delete: refresh the views and leave. `alreadySaved`: an earlier attempt saved this new entry. */
  readonly leave: (data: { entry: Entry; alreadySaved: boolean }) => Promise<void>
}

/** A target in a group or private context that exists already: every target but a new ungrouped expense. */
export type GroupEntryTarget = EntryTarget & { readonly groupId: string }

/** A write whose answer was lost may have happened; the form keeps its key, so a retry cannot save twice. */
const UNCONFIRMED = 'The server did not confirm the change. Try again: a retry cannot save it twice.'

/** Creates or updates an entry of an existing group or private context. */
const saveInGroup =
  (groupId: string): EntryTarget['save'] =>
  ({ entry, expense, idempotencyKey }) =>
    rpc((api) =>
      entry.mode === 'create'
        ? api('expenses.create', { groupId, expenseId: entry.expenseId, idempotencyKey, expense })
        : api('expenses.update', { groupId, expenseId: entry.expenseId, expectedRevision: entry.revision, idempotencyKey, expense }),
    ).then(() => undefined)

const existsInGroup =
  (groupId: string): EntryTarget['exists'] =>
  (expenseId) =>
    rpc((api) => api('expenses.detail', { groupId, expenseId })).then(
      () => true,
      () => false,
    )

/** An entry on a group's pages: it returns to the expense or payment list. */
export function useGroupTarget(data: { groupId: string; group: string; kind: ExpenseKind }): GroupEntryTarget {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const back = { to: data.kind === 'payment' ? '/$group/payments' : '/$group/expenses', params: { group: data.group } } as const
  return {
    groupId: data.groupId,
    privateExpense: false,
    back,
    save: saveInGroup(data.groupId),
    exists: existsInGroup(data.groupId),
    leave: async ({ entry, alreadySaved }) => {
      await afterWrite({ queryClient, scope: 'group', groupId: data.groupId })
      // An expense that an earlier attempt saved opens in its editor (P-EXP-39).
      if (alreadySaved && data.kind === 'expense') await navigate(editorLink({ group: data.group, expenseId: entry.expenseId, kind: data.kind }))
      else await navigate(back)
    },
  }
}

/** An entry on the /expenses pages: it returns to the original private expense, or the dashboard. */
export function usePageTarget(data: { groupId: string; privateExpense: boolean; back: Extract<BackLink, { to: '/' | '/expenses/$expenseId' }> }): GroupEntryTarget {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return {
    groupId: data.groupId,
    privateExpense: data.privateExpense,
    back: data.back,
    save: saveInGroup(data.groupId),
    exists: existsInGroup(data.groupId),
    leave: async () => {
      await afterWrite({ queryClient, scope: 'group', groupId: data.groupId })
      await navigate(data.back)
    },
  }
}

/**
 * Saves and deletes one entry. Each distinct draft gets one idempotency key, so
 * a retry after a lost answer cannot save twice. A create that fails but whose
 * entry exists now was saved by an earlier attempt: the form says so and
 * moves on (P-EXP-39, P-BAL-84, P-UNGROUP-19).
 */
export function useEntryWrite(data: { target: EntryTarget; entry: Entry; noun: 'expense' | 'payment' }) {
  const { target, entry } = data
  const keys = useRef(new Map<string, string>())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  const submit = async (expense: ExpenseInput, onSaved?: () => void) => {
    const signature = JSON.stringify(expense)
    const idempotencyKey = keys.current.get(signature) ?? newIdempotencyKey()
    keys.current.set(signature, idempotencyKey)
    setFailure(null)
    setBusy(true)
    try {
      await target.save({ entry, expense, idempotencyKey })
      onSaved?.()
      await target.leave({ entry, alreadySaved: false })
    } catch (cause) {
      const described = describeError(cause, UNCONFIRMED)
      if (entry.mode === 'create' && (described.kind === 'conflict' || described.kind === 'unknown') && (await target.exists(entry.expenseId))) {
        toast.success(`This ${data.noun} was already saved.`)
        await target.leave({ entry, alreadySaved: true })
        return
      }
      setFailure(described)
    } finally {
      setBusy(false)
    }
  }

  /** Deletes a saved entry; rejects with an RpcError, which the delete dialog shows. */
  const remove = async () => {
    if (entry.mode !== 'edit' || target.groupId === null) return
    const groupId = target.groupId
    await rpc((api) => api('expenses.delete', { groupId, expenseId: entry.expenseId, expectedRevision: entry.revision, idempotencyKey: newIdempotencyKey() }))
    await target.leave({ entry, alreadySaved: false })
  }

  return { busy, failure, submit, remove, clearFailure: () => setFailure(null) }
}
