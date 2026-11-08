import { useState, type ReactElement } from 'react'
import { describeError } from '~/client/errors'
import { Button } from '~/client/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '~/client/ui/dialog'

/**
 * The confirmation of a destructive action. It stays open and says why when
 * the action fails (P-EXP-52). It opens from `trigger`, or, for a menu item,
 * from the caller's `open` state. `pending` replaces "Deleting…" while it runs.
 */
export function DeleteDialog(
  props: { title: string; description?: string; onConfirm: () => Promise<unknown>; pending?: string } & (
    | { trigger: ReactElement; open?: undefined; onOpenChange?: undefined }
    | { trigger?: undefined; open: boolean; onOpenChange: (open: boolean) => void }
  ),
) {
  const [ownOpen, setOwnOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = props.open ?? ownOpen
  const setOpen = (value: boolean) => {
    setError(null)
    if (props.onOpenChange) props.onOpenChange(value)
    else setOwnOpen(value)
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {props.trigger && (
        <DialogTrigger asChild type="button">
          {props.trigger}
        </DialogTrigger>
      )}
      <DialogContent {...(props.description ? {} : { 'aria-describedby': undefined })}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
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
                setError(describeError(cause).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? (props.pending ?? 'Deleting…') : 'Yes'}
          </Button>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
