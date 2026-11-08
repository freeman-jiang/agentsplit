// Receipts on an expense, ported from the current app's
// src/components/expense-documents-input.tsx. Images upload to
// /api/receipts and always load through it, never from storage directly.
// Photos shrink in the browser first (receipt-files.ts).
import { Loader2, Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/client/ui/button'
import { Dialog, DialogContent, DialogTitle } from '~/client/ui/dialog'
import type { DocumentInput } from '~/shared/api'
import type { HttpErrorBody } from '~/shared/errors'
import { LIMITS, mebibytes } from '~/shared/limits'
import { RECEIPTS_PATH, receiptDownloadPath } from '~/shared/paths'
import { RECEIPT_CONTENT_TYPES } from '~/shared/vocabulary'
import { prepareReceipt, tombstoneText, type Tombstone } from './receipt-files'

/** `deleted` is set for a receipt that was deleted for good: it shows a tombstone, and saving needs it removed. */
export type FormDocument = { id: string; url: string; width: number; height: number; deleted?: Tombstone | null }

async function upload(data: { groupId: string; file: File }): Promise<typeof DocumentInput.Type> {
  const body = new FormData()
  body.set('groupId', data.groupId)
  body.set('file', data.file)
  const response = await fetch(RECEIPTS_PATH, { method: 'POST', body, credentials: 'same-origin' })
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as HttpErrorBody | null)?.error ?? `Upload failed (${response.status})`)
  return (await response.json()) as typeof DocumentInput.Type
}

export function ExpenseDocuments(props: { groupId: string; documents: readonly FormDocument[]; onChange: (documents: FormDocument[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const latest = useRef(props.documents)
  latest.current = props.documents

  const send = async (original: File) => {
    setUploading(true)
    const file = await prepareReceipt(original)
    setUploading(false)
    if (file.size > LIMITS.receiptBytes) {
      toast.error('File too large', { description: `The limit is ${mebibytes(LIMITS.receiptBytes)}. This file is ${mebibytes(file.size)}.` })
      return
    }
    setUploading(true)
    try {
      const doc = await upload({ groupId: props.groupId, file })
      props.onChange([...latest.current, doc])
    } catch (error) {
      toast.error('Could not upload the receipt', {
        description: error instanceof Error ? error.message : 'Try again, or choose a different file.',
        action: { label: 'Try again', onClick: () => void send(original) },
      })
    } finally {
      setUploading(false)
    }
  }

  const opened = open === null ? undefined : props.documents[open]
  const shown = opened?.deleted ? undefined : opened
  return (
    <div className="flex flex-wrap gap-3">
      {props.documents.map((doc, index) =>
        doc.deleted ? (
          <div key={doc.id} className="flex h-20 w-40 flex-col justify-between border bg-muted p-2 text-xs text-muted-foreground">
            <p>{tombstoneText(doc.deleted)}</p>
            <button type="button" className="self-start underline" onClick={() => props.onChange(props.documents.filter((d) => d.id !== doc.id))}>
              Remove
            </button>
          </div>
        ) : (
          <button
            key={doc.id}
            type="button"
            onClick={() => setOpen(index)}
            className="h-20 w-20 overflow-hidden border bg-muted"
            aria-label={`Open receipt ${index + 1}`}
          >
            <img src={receiptDownloadPath({ groupId: props.groupId, url: doc.url })} alt="" width={doc.width} height={doc.height} className="h-full w-full object-cover" loading="lazy" />
          </button>
        ),
      )}
      <input
        ref={input}
        type="file"
        accept={RECEIPT_CONTENT_TYPES.join(',')}
        className="hidden"
        aria-label="Attach receipt"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void send(file)
        }}
      />
      <Button type="button" variant="outline" className="h-20 w-20" disabled={uploading} onClick={() => input.current?.click()} aria-label="Attach receipt">
        {uploading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Paperclip className="h-5 w-5" aria-hidden="true" />}
      </Button>
      <Dialog open={shown !== undefined} onOpenChange={(value) => !value && setOpen(null)}>
        <DialogContent className="max-h-dvh max-w-[100vw] sm:max-w-3xl">
          <DialogTitle className="sr-only">Receipt</DialogTitle>
          {shown && (
            <>
              <img src={receiptDownloadPath({ groupId: props.groupId, url: shown.url })} alt="Receipt" className="max-h-[75dvh] w-full object-contain" />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    props.onChange(props.documents.filter((d) => d.id !== shown.id))
                    setOpen(null)
                  }}
                >
                  <X className="mr-1 h-4 w-4" aria-hidden="true" />
                  Remove receipt
                </Button>
                <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
