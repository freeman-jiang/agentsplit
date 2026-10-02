import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  agentKeySchema,
  hashAccessKey,
  userAccessSchema,
} from '../src/lib/mcp/access'

const { values } = parseArgs({
  options: {
    'connection-id': { type: 'string' },
    'user-id': { type: 'string' },
    'group-id': { type: 'string', multiple: true },
    out: { type: 'string' },
  },
})
const token = randomBytes(32).toString('hex')
const key = agentKeySchema.parse({
  id: values['connection-id'],
  userId: values['user-id'],
  tokenSha256: hashAccessKey(token),
})
const user = values['group-id']
  ? userAccessSchema.parse({ id: key.userId, groupIds: values['group-id'] })
  : undefined
const output = path.resolve(values.out ?? `.mcp-credentials/${key.id}.json`)
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
// Refuse overwrites: a restart/deploy must never silently rotate an agent's key.
await writeFile(output, JSON.stringify({ token, key, user }, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
})
process.stdout.write(`Created private MCP credential file: ${output}\n`)
