import { useState } from 'react'
import { Button } from '~/client/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '~/client/ui/dialog'
import { describeWriteError } from './write-error'

/** A confirmation that stays open and says why when the delete fails (P-EXP-52). */
/** `quiet` gives the trigger an outline, for a list with one per row; the confirm button stays destructive. */
export function DeleteDialog(props: { label: string; title: string; description: string; onConfirm: () => Promise<void>; quiet?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant={props.quiet ? 'outline' : 'destructive'} size={props.quiet ? 'sm' : 'default'}>
          {props.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await props.onConfirm()
                setOpen(false)
              } catch (cause) {
                setError(describeWriteError(cause).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Deleting…' : 'Yes'}
          </Button>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
