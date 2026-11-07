import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from './button'

/** Copies `text` exactly and shows a check for a second; `title` is also the accessible name. */
export function CopyButton(props: { text: string; title: string; variant?: 'secondary' | 'outline'; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 1000)
    return () => clearTimeout(timeout)
  }, [copied])
  return (
    <Button
      size="icon"
      variant={props.variant ?? 'secondary'}
      type="button"
      title={props.title}
      aria-label={props.title}
      className={props.className}
      onClick={() =>
        void navigator.clipboard.writeText(props.text).then(
          () => setCopied(true),
          () => toast.error('Could not copy. Select the text and copy it yourself.'),
        )
      }
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}
