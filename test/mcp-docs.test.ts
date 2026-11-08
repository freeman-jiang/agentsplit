// MCP.md is the agents' contract, and nothing else ties it to the code: a tool
// added, moved or turned into a write, a new error code, or a changed limit or
// token lifetime would leave the document wrong without any failure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '../src/server/mcp/tools'
import { ERROR_ANSWERS } from '../src/shared/errors'
import { FAIR_USE_LABELS, FAIR_USE_LIMITS, LIMITS, mebibytes, megabytes } from '../src/shared/limits'

const doc = readFileSync(join(import.meta.dirname, '..', 'MCP.md'), 'utf8')

/** The body rows of the first table under a `## heading`, as cells. */
function table(heading: string): string[][] {
  const lines = (doc.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '').split('\n')
  const start = lines.findIndex((line) => line.startsWith('| ---'))
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'))
  return lines.slice(start + 1, end).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, '')))
}

describe('MCP.md', () => {
  it('lists every tool in the tools/list order, with its kind and count', () => {
    expect(table('Tools').map(([name, kind]) => [name, kind])).toEqual(MCP_TOOLS.map((tool) => [tool.name, tool.kind]))
    expect(doc).toContain(`The ${MCP_TOOLS.length} tools, in the order that \`tools/list\` gives them.`)
  })

  it('explains every error code that a tool result can carry', () => {
    const codes = new Set<string>(Object.values(ERROR_ANSWERS).map((answer) => answer.mcp))
    expect(table('Errors').map(([code]) => code).sort()).toEqual([...codes].sort())
  })

  it('states every fair-use limit with its value', () => {
    const value = (key: keyof typeof FAIR_USE_LIMITS) =>
      key === 'receiptStorageBytes' ? megabytes(LIMITS[key]) : key === 'receiptBytes' ? mebibytes(LIMITS[key]) : String(LIMITS[key])
    const keys = Object.keys(FAIR_USE_LABELS) as (keyof typeof FAIR_USE_LIMITS)[]
    const rows = table('Fair-use limits')
    expect(rows.map(([label]) => label)).toEqual(keys.map((key) => FAIR_USE_LABELS[key]))
    for (const [i, key] of keys.entries()) expect(rows[i]?.[1], key).toContain(value(key))
  })

  it('states the rate limits, the token lifetimes and the upload times that the code applies', () => {
    for (const text of [
      `Access tokens live ${LIMITS.accessTokenSeconds} seconds; refresh tokens live ${LIMITS.refreshTokenDays} days`,
      `after the ${LIMITS.accessTokenSeconds}-second access token expires`,
      `a bucket of ${LIMITS.mcpRequestsPerMinute} requests, refilled at ${LIMITS.mcpRequestsPerMinute / 60} requests per second`,
      `at most ${LIMITS.apiKeyRequestsPerMinute} requests in 60 seconds`,
      `about ${LIMITS.writesPerMinute} per minute`,
      `at most ${LIMITS.clientRegistrationsPerHour} registrations per IP address per hour`,
      `at most ${mebibytes(LIMITS.receiptBytes)} each, at most ${LIMITS.receiptsPerRequest} per request`,
      `receipt storage (${megabytes(LIMITS.receiptStorageBytes)})`,
      `within ${LIMITS.uploadTargetSeconds} seconds`,
      `within ${LIMITS.uploadAttachHours} hours`,
      `after ${LIMITS.uploadAttachHours + 1} hours`,
    ])
      expect(doc).toContain(text)
  })
})
