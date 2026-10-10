import { createHash, timingSafeEqual } from 'node:crypto'
import { readApiKey } from '@/lib/api-key-header'
import * as z from 'zod'

export const agentKeySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    userId: z.string().min(1).max(80),
    tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const userAccessSchema = z
  .object({
    id: z.string().min(1).max(80),
    groupIds: z.array(z.string().min(1).max(64)).max(1000),
  })
  .strict()

export const accessConfigurationSchema = z
  .object({
    users: z.array(userAccessSchema).min(1).max(100),
    keys: z.array(agentKeySchema).min(1).max(100),
  })
  .strict()
  .superRefine(({ users, keys }, ctx) => {
    const userIds = new Set(users.map((user) => user.id))
    if (userIds.size !== users.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate user ID' })
    }
    if (new Set(keys.map((key) => key.id)).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate connection ID' })
    }
    if (new Set(keys.map((key) => key.tokenSha256)).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate access key' })
    }
    if (keys.some((key) => !userIds.has(key.userId))) {
      ctx.addIssue({
        code: 'custom',
        message: 'Agent key must belong to a user',
      })
    }
  })

export type AgentKey = z.infer<typeof agentKeySchema>
export type McpPrincipal = {
  /** Undefined for existing API keys; OAuth grants carry an explicit ceiling. */
  scopes?: string[]
  oauthConnectionId?: string
  id: string
  userId: string
  name?: string
  groupIds: string[]
}

export function hashAccessKey(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function reject(status: number, message: string) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(status === 401
          ? { 'WWW-Authenticate': 'Bearer realm="AgentSplit MCP"' }
          : {}),
      },
    },
  )
}

/** Credentials determine identity and group access; model arguments never do. */
export function authorizeMcpRequest(
  request: Request,
  configuration = process.env.MCP_ACCESS_GRANTS,
): { principal: McpPrincipal } | { response: Response } {
  if (!configuration?.trim()) {
    return { response: reject(404, 'MCP is not configured') }
  }

  const origin = request.headers.get('origin')
  const expectedUrl = new URL(process.env.BASE_URL || request.url)
  const expectedOrigin = expectedUrl.origin
  const requestedHost = request.headers.get('host') ?? new URL(request.url).host
  let hostMatches = false
  try {
    const hostUrl = new URL(`${expectedUrl.protocol}//${requestedHost}`)
    hostMatches =
      hostUrl.host === expectedUrl.host &&
      hostUrl.pathname === '/' &&
      !hostUrl.username &&
      !hostUrl.password &&
      !hostUrl.search &&
      !hostUrl.hash
  } catch {
    // Malformed Host headers must fail closed rather than throw a server error.
  }
  if (!hostMatches) {
    return { response: reject(403, 'Host is not allowed') }
  }
  if (origin && origin !== expectedOrigin) {
    return { response: reject(403, 'Origin is not allowed') }
  }

  let access: z.infer<typeof accessConfigurationSchema>
  try {
    access = accessConfigurationSchema.parse(JSON.parse(configuration))
  } catch {
    return {
      response: reject(503, 'MCP authorization is not configured correctly'),
    }
  }

  const token = readApiKey(request.headers)
  if (!token || token.length < 32 || token.length > 4096) {
    return { response: reject(401, 'Authentication required') }
  }

  const candidate = Buffer.from(hashAccessKey(token), 'hex')
  const key = access.keys.find((entry) =>
    timingSafeEqual(candidate, Buffer.from(entry.tokenSha256, 'hex')),
  )
  if (!key) return { response: reject(401, 'Authentication required') }
  const user = access.users.find((entry) => entry.id === key.userId)
  if (!user) return { response: reject(401, 'Authentication required') }

  return {
    principal: { id: key.id, userId: user.id, groupIds: user.groupIds },
  }
}

export function assertGroupAccess(
  procedure: string,
  argumentsValue: unknown,
  principal: McpPrincipal,
) {
  if (
    !procedure.startsWith('groups.') ||
    procedure === 'groups.create' ||
    procedure === 'groups.access'
  )
    return
  const input = z
    .object({
      groupId: z.string().optional(),
      groupIds: z.array(z.string()).optional(),
      groups: z.array(z.object({ groupId: z.string() })).optional(),
    })
    .parse(argumentsValue)
  const requested =
    procedure === 'groups.expenses.create' && input.groupId === undefined
      ? []
      : procedure === 'groups.list'
        ? (input.groupIds ?? principal.groupIds)
        : procedure === 'groups.balances.forUser'
          ? input.groups?.map((group) => group.groupId)
          : input.groupId
            ? [input.groupId]
            : undefined
  if (!requested || requested.some((id) => !principal.groupIds.includes(id))) {
    throw new Error('This connection cannot access the requested group')
  }
}
