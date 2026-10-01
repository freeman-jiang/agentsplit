import { effectiveGroupIds } from '@/lib/group-access'
import { authorizeMcpRequest } from '@/lib/mcp/access'
import { limitMcpRequest } from '@/lib/mcp/rate-limit'
import { createAgentSplitMcpServer } from '@/lib/mcp/server'
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handleRequest(request: Request) {
  const authorization = authorizeMcpRequest(request)
  if ('response' in authorization) return authorization.response
  const retryAfter = limitMcpRequest(authorization.principal.userId)
  if (retryAfter) {
    return Response.json(
      { error: 'MCP request rate exceeded' },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfter),
        },
      },
    )
  }

  try {
    authorization.principal.groupIds = await effectiveGroupIds(
      authorization.principal.userId,
      authorization.principal.groupIds,
    )
  } catch {
    return Response.json(
      { error: 'MCP group access is temporarily unavailable' },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  }

  // SDK 2.0.0 leaves this modern-protocol header check to the mounting server.
  if (
    request.method === 'POST' &&
    !(await isLegacyRequest(request)) &&
    !request.headers.get('mcp-protocol-version')
  ) {
    const body: unknown = await request.clone().json()
    const id =
      body &&
      typeof body === 'object' &&
      'id' in body &&
      (typeof body.id === 'string' || typeof body.id === 'number')
        ? body.id
        : null
    return Response.json(
      {
        jsonrpc: '2.0',
        id,
        error: { code: -32020, message: 'MCP-Protocol-Version is required' },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const handler = createMcpHandler(
    () => createAgentSplitMcpServer(authorization.principal),
    { responseMode: 'json' },
  )
  try {
    const response = await handler.fetch(request)
    response.headers.set('Cache-Control', 'no-store')
    return response
  } finally {
    await handler.close()
  }
}

export { handleRequest as GET, handleRequest as POST, handleRequest as DELETE }
