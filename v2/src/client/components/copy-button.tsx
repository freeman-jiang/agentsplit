import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '~/client/ui/button'

/** Copies `text` exactly; `title` is also the accessible name. */
export function CopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 1000)
    return () => clearTimeout(timeout)
  }, [copied])
  return (
    <Button
      size="icon"
      variant="secondary"
      type="button"
      title={title}
      aria-label={title}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}
