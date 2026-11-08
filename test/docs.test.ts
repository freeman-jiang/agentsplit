// MCP.md is the agents' contract, and AUTH.md, PRIVACY.md and DEPLOYMENT.md
// state the limits to people. Nothing else ties them to the code: a tool
// added, moved or turned into a write, a new error code, or a changed limit or
// token lifetime would leave a document wrong without any failure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LONG_SIDE } from '../src/client/components/receipt-files'
import { MCP_TOOLS } from '../src/server/mcp/tools'
import { ERROR_ANSWERS } from '../src/shared/errors'
import { FAIR_USE_LABELS, FAIR_USE_LIMITS, LIMITS, mebibytes, megabytes } from '../src/shared/limits'

const read = (file: string) => readFileSync(join(import.meta.dirname, '..', file), 'utf8')
const doc = read('MCP.md')

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
    // The whole number: "10" must not pass for a limit of 1.
    const whole = (text: string) => new RegExp(`(^|[^\\d.])${text.replaceAll('.', '\\.')}($|[^\\d.])`)
    for (const [i, key] of keys.entries()) expect(rows[i]?.[1], key).toMatch(whole(value(key)))
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

describe.each([
  {
    file: 'AUTH.md',
    sentences: [
      `at most ${LIMITS.signUpsPerDay} created in 24 hours`,
      `A session lasts ${LIMITS.sessionDays} days and is refreshed once a day.`,
      `expires after ${LIMITS.invitationDays} days`,
      `A key allows ${LIMITS.apiKeyRequestsPerMinute} requests in 60 seconds.`,
      `at most ${LIMITS.apiKeys} keys`,
      `at most ${LIMITS.clientRegistrationsPerHour} times per IP address per hour`,
      `Access tokens are signed JWTs that live ${LIMITS.accessTokenSeconds} seconds.`,
      `a refresh token that lives ${LIMITS.refreshTokenDays} days`,
    ],
  },
  {
    file: 'PRIVACY.md',
    sentences: [
      `expire after ${LIMITS.invitationDays} days`,
      `expires after ${LIMITS.uploadTargetSeconds} seconds`,
      `at most ${LONG_SIDE} pixels on the long side`,
      `Each account has ${megabytes(LIMITS.receiptStorageBytes)} of receipt storage`,
      `Unattached agent uploads are deleted after ${LIMITS.uploadAttachHours + 1} hours.`,
    ],
  },
  { file: 'DEPLOYMENT.md', sentences: [`empty means ${LIMITS.signUpsPerDay}.`] },
])('$file', ({ file, sentences }) => {
  it('states the limits that the code applies', () => {
    const text = read(file)
    for (const sentence of sentences) expect(text).toContain(sentence)
  })
})
