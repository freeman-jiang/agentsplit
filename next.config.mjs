import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin()

// Allow only the configured storage origin. Other third-party assets and
// browser connections stay blocked. This configuration is baked at build time.
const storageUrl = (() => {
  if (!process.env.S3_UPLOAD_ENDPOINT) return null
  const url = new URL(process.env.S3_UPLOAD_ENDPOINT)
  return ['http:', 'https:'].includes(url.protocol) ? url : null
})()
const storageSource = storageUrl ? ` ${storageUrl.origin}` : ''

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server into .next/standalone, containing only the
  // files Next.js traced as actually reachable at runtime. The Docker runtime
  // stage copies that instead of a full production `node_modules`.
  output: 'standalone',
  images: {
    remotePatterns: storageUrl
      ? [
          {
            protocol: storageUrl.protocol === 'https:' ? 'https' : 'http',
            hostname: storageUrl.hostname,
            port: storageUrl.port,
            pathname: '/**',
          },
        ]
      : [],
  },
  reactCompiler: true,
  // Required to run in a codespace (see https://github.com/vercel/next.js/issues/58019)
  experimental: {
    serverActions: {
      // localhost:3000 covers local dev and same-host container access; the
      // configured base URL covers a deployment reached under its own domain,
      // whose server actions would otherwise be rejected as cross-origin.
      // An unparseable value is ignored here rather than thrown: this file is
      // evaluated before the env schema runs, and its `Invalid URL` is far less
      // useful than the validation error the schema is about to produce.
      allowedOrigins: (() => {
        const base = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL
        try {
          return ['localhost:3000', ...(base ? [new URL(base).host] : [])]
        } catch {
          return ['localhost:3000']
        }
      })(),
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:${storageSource}; font-src 'self' data:; connect-src 'self'${storageSource}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ]
  },
}

export default withNextIntl(nextConfig)
