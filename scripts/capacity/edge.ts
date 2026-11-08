// A stand-in for Cloudflare's edge and the tunnel connector, between the
// benchmark's clients and the server. It serves the files of the client build
// itself, as the edge cache does, and forwards everything else (the API and
// the SPA page) to the server with `Accept-Encoding: gzip`, as Cloudflare asks
// the origin. For each forwarded request it counts the bytes that would leave
// the VM: the status line, the response headers and the body as the server
// sent it.
import { readdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

const TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
}

export type Exchange = {
  /** What the request was, such as "rpc feed.list+groups.list" or "mcp tools/call list_expenses". */
  readonly label: string
  readonly phase: string
  readonly status: number
  /** The status line, the headers and the blank line, as HTTP/1.1 text. */
  readonly headerBytes: number
  /** The body as the server sent it (gzipped when it gzipped it). */
  readonly bodyBytes: number
  /** The body after gunzip, or the body itself. */
  readonly decodedBytes: number
  readonly gzipped: boolean
  readonly milliseconds: number
}

export type Edge = {
  readonly origin: string
  /** Every forwarded request so far, in order. */
  readonly exchanges: readonly Exchange[]
  /** Names the phase that later exchanges belong to. */
  readonly setPhase: (phase: string) => void
  readonly close: () => Promise<void>
}

/** The files of the client build by path, except the SPA page, which the server renders. */
function staticFiles(dir: string): ReadonlyMap<string, { readonly type: string; readonly bytes: Uint8Array }> {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  const files = new Map<string, { type: string; bytes: Uint8Array }>()
  for (const file of walk(dir)) {
    const name = relative(dir, file)
    if (name === 'index.html' || /\.(br|gz)$/.test(name)) continue
    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
    files.set(`/${name}`, { type: TYPES[extension] ?? 'application/octet-stream', bytes: new Uint8Array(readFileSync(file)) })
  }
  return files
}

/** The label of a request to the server, from its path and body. */
function labelOf(data: { method: string; path: string; body: string }): string {
  const { method, path, body } = data
  if (path === '/api/rpc') {
    try {
      const batch = JSON.parse(body) as readonly { readonly tag?: string }[]
      return `rpc ${batch.map((r) => r.tag ?? '?').join('+')}`
    } catch {
      return 'rpc (unreadable)'
    }
  }
  if (path === '/api/mcp') {
    if (method !== 'POST') return `mcp ${method}`
    try {
      const message = JSON.parse(body) as { readonly method?: string; readonly params?: { readonly name?: string } }
      return `mcp ${message.method ?? '?'}${message.params?.name ? ` ${message.params.name}` : ''}`
    } catch {
      return 'mcp (unreadable)'
    }
  }
  if (path.startsWith('/api/auth/')) return `auth ${path.slice('/api/auth/'.length)}`
  if (path.startsWith('/api/')) return `api ${path}`
  return 'page (SPA document)'
}

const headerBytes = (response: http.IncomingMessage) => {
  let bytes = `HTTP/1.1 ${response.statusCode ?? 0} ${response.statusMessage ?? ''}\r\n`.length + 2
  for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) bytes += Buffer.byteLength(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`)
  return bytes
}

/** Starts the edge on loopback `port`, in front of the server at `target`. */
export async function startEdge(data: { clientDir: string; target: { host: string; port: number }; port: number }): Promise<Edge> {
  const files = staticFiles(data.clientDir)
  const exchanges: Exchange[] = []
  let phase = 'setup'
  // cloudflared keeps its connections to the origin open.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://edge')
    const file = request.method === 'GET' || request.method === 'HEAD' ? files.get(url.pathname) : undefined
    if (file) {
      response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.byteLength, 'Cache-Control': 'public, max-age=31536000' })
      response.end(request.method === 'HEAD' ? undefined : file.bytes)
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const started = performance.now()
      const label = labelOf({ method: request.method ?? 'GET', path: url.pathname, body: body.toString('utf8') })
      const at = phase
      const headers = { ...request.headers, 'accept-encoding': 'gzip' }
      delete headers['connection']
      const upstream = http.request({ host: data.target.host, port: data.target.port, method: request.method, path: request.url, headers, agent }, (answer) => {
        const parts: Buffer[] = []
        answer.on('data', (chunk: Buffer) => parts.push(chunk))
        answer.on('end', () => {
          const raw = Buffer.concat(parts)
          const gzipped = (answer.headers['content-encoding'] ?? '').toLowerCase() === 'gzip'
          exchanges.push({
            label,
            phase: at,
            status: answer.statusCode ?? 0,
            headerBytes: headerBytes(answer),
            bodyBytes: raw.byteLength,
            decodedBytes: gzipped ? gunzipSync(raw).byteLength : raw.byteLength,
            gzipped,
            milliseconds: performance.now() - started,
          })
          const forwarded: Record<string, string | string[]> = {}
          for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && name !== 'transfer-encoding' && name !== 'connection') forwarded[name] = value
          forwarded['content-length'] = String(raw.byteLength)
          response.writeHead(answer.statusCode ?? 502, forwarded)
          response.end(raw)
        })
      })
      upstream.on('error', (error) => {
        console.error('Edge: the server did not answer', { label }, error)
        response.writeHead(502)
        response.end()
      })
      upstream.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(data.port, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${data.port}`,
    exchanges,
    setPhase: (next) => void (phase = next),
    close: async () => {
      // Bun's server stops at closeAllConnections when it has no open request; close() then reports that it is not running.
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      agent.destroy()
    },
  }
}
