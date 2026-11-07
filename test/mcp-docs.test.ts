// MCP.md is the agents' contract, and nothing else ties it to the code: a tool
// added, moved or turned into a write, or a new error code, would leave the
// document wrong without any failure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '../src/server/mcp/tools'
import { ERROR_ANSWERS } from '../src/shared/errors'

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
})
