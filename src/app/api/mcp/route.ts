import { authorizeMcpRequest } from '@/lib/mcp/access'
import { createAgentSplitMcpServer } from '@/lib/mcp/server'
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handleRequest(request: Request) {
  const authorization = authorizeMcpRequest(request)
  if ('response' in authorization) return authorization.response

  // SDK 2.0.0 leaves this modern-protocol header check to the mounting server.
  if (
    request.method === 'POST' &&
    !(await isLegacyRequest(request)) &&
    !request.headers.get('mcp-protocol-version')
  ) {
    return Response.json(
      { error: 'MCP-Protocol-Version is required' },
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
