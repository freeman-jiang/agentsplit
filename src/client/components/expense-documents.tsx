// Receipts on an expense, ported from the current app's
// src/components/expense-documents-input.tsx. Images upload to
// /api/receipts and always load through it, never from storage directly.
// Photos shrink in the browser first (receipt-files.ts).
import { Loader2, Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/client/ui/button'
import { Dialog, DialogContent, DialogTitle } from '~/client/ui/dialog'
import type { Reference } from '~/shared/api'
import { mebibytes } from '~/shared/limits'
import { prepareReceipt, tombstoneText, type Tombstone } from './receipt-files'

/** `deleted` is set for a receipt that was deleted for good: it shows a tombstone, and saving needs it removed. */
export type FormDocument = { id: string; url: string; width: number; height: number; deleted?: Tombstone | null }

const receiptSrc = (data: { groupId: string; url: string }) => `/api/receipts?${new URLSearchParams({ groupId: data.groupId, url: data.url })}`

type Uploaded = { id: string; url: string; width: number; height: number }

async function upload(data: { groupId: string; file: File }): Promise<Uploaded> {
  const body = new FormData()
  body.set('groupId', data.groupId)
  body.set('file', data.file)
  const response = await fetch('/api/receipts', { method: 'POST', body, credentials: 'same-origin' })
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `Upload failed (${response.status})`)
  return (await response.json()) as Uploaded
}

/** `attachments` are the server's limits for receipts (reference.get). */
export function ExpenseDocuments(props: { groupId: string; attachments: (typeof Reference.Type)['attachments']; documents: readonly FormDocument[]; onChange: (documents: FormDocument[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const latest = useRef(props.documents)
  latest.current = props.documents

  const send = async (original: File) => {
    setUploading(true)
    const file = await prepareReceipt(original)
    setUploading(false)
    const { maxBytes } = props.attachments
    if (file.size > maxBytes) {
      toast.error('The file is too big', { description: `The maximum file size you can upload is ${mebibytes(maxBytes)}. Yours is ${mebibytes(file.size)}.` })
      return
    }
    setUploading(true)
    try {
      const doc = await upload({ groupId: props.groupId, file })
      props.onChange([...latest.current, doc])
    } catch (error) {
      toast.error('Error while uploading document', {
        description: error instanceof Error ? error.message : 'Something wrong happened when uploading the document. Please retry later or select a different file.',
        action: { label: 'Retry', onClick: () => void send(original) },
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
            aria-label={`Open document ${index + 1}`}
          >
            <img src={receiptSrc({ groupId: props.groupId, url: doc.url })} alt="" width={doc.width} height={doc.height} className="h-full w-full object-cover" loading="lazy" />
          </button>
        ),
      )}
      <input
        ref={input}
        type="file"
        accept={props.attachments.contentTypes.join(',')}
        className="hidden"
        aria-label="Attach documents"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void send(file)
        }}
      />
      <Button type="button" variant="outline" className="h-20 w-20" disabled={uploading} onClick={() => input.current?.click()} aria-label="Attach documents">
        {uploading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Paperclip className="h-5 w-5" aria-hidden="true" />}
      </Button>
      <Dialog open={shown !== undefined} onOpenChange={(value) => !value && setOpen(null)}>
        <DialogContent className="max-h-dvh max-w-[100vw] sm:max-w-3xl">
          <DialogTitle className="sr-only">Document</DialogTitle>
          {shown && (
            <>
              <img src={receiptSrc({ groupId: props.groupId, url: shown.url })} alt="Receipt" className="max-h-[75dvh] w-full object-contain" />
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
                  Delete document
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
