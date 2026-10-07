import { exportJSON } from '@/lib/export-json'
import { authorizeGroupRequest } from '@/lib/session'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await params
  const access = await authorizeGroupRequest(req, groupId)
  if (access instanceof Response) return access
  return exportJSON(groupId)
}
