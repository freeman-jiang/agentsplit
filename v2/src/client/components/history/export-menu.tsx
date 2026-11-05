// The Expenses tab's "Export" menu (P-EXPORT-01). The Expenses tab belongs to
// the expenses area: render <ExportMenu group={group} /> in its toolbar.
import { Download, FileDown, FileJson } from 'lucide-react'
import { Button } from '~/client/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/client/ui/dropdown-menu'

/** The export files open in a new tab; the Worker serves them, not the SPA. */
export const exportHref = (data: { group: string; format: 'csv' | 'json' }) => `/${encodeURIComponent(data.group)}/expenses/export/${data.format}`

export function ExportMenu({ group }: { group: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button title="Export" aria-label="Export" variant="secondary" size="icon">
          <Download className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <a href={exportHref({ group, format: 'json' })} target="_blank" rel="noopener" className="flex items-center gap-2">
            <FileJson className="h-4 w-4" />
            Export to JSON
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={exportHref({ group, format: 'csv' })} target="_blank" rel="noopener" className="flex items-center gap-2">
            <FileDown className="h-4 w-4" />
            Export to CSV
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
