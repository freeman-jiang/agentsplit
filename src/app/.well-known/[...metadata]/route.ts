import { getAuth } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Forward the original well-known path; the official provider owns the metadata. */
export async function GET(request: Request) {
  return getAuth().handler(request)
}
export const HEAD = GET
