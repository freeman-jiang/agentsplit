// The Expenses tab's "Export" menu (P-EXPORT-01).
import { Download, FileArchive, FileDown, FileJson } from 'lucide-react'
import { segmentPath } from '~/shared/groups'
import { Button } from '~/client/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/client/ui/dropdown-menu'

/** The export files open in a new tab; the server serves them, not the SPA. `receipts` is a ZIP file of every receipt. */
const exportHref = (data: { group: string; format: 'csv' | 'json' | 'receipts' }) => `${segmentPath(data.group)}/expenses/export/${data.format}`

export function ExportMenu({ group }: { group: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The input shape, like the search field and the sort control beside it. */}
        <Button title="Export" aria-label="Export" variant="outline" size="icon" className="rounded-xl border-input">
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
        <DropdownMenuItem asChild>
          <a href={exportHref({ group, format: 'receipts' })} download className="flex items-center gap-2">
            <FileArchive className="h-4 w-4" />
            Download all receipts
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
