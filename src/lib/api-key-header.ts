/** The same raw API key works for MCP, exports, and private receipt reads. */
export function hasApiKeyHeader(headers: Headers) {
  return headers.has('x-api-key') || headers.has('authorization')
}

export function readApiKey(headers: Headers): string | undefined {
  const direct = headers.get('x-api-key')
  const authorization = headers.get('authorization')
  const bearer = authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1]
  if (authorization !== null && !bearer) return undefined
  const valid = (key: string) =>
    key.length >= 32 && key.length <= 4096 && /^[^\s,]+$/.test(key)
  if (direct !== null && !valid(direct)) return undefined
  if (bearer !== undefined && !valid(bearer)) return undefined
  // Do not silently choose an identity when two different credentials are sent.
  if (direct !== null && bearer !== undefined && direct !== bearer)
    return undefined
  return direct ?? bearer
}
