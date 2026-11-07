// Every setting of the server process, read and checked once at start
// (server.ts). A missing or malformed setting stops the server with its name.
// DEPLOYMENT.md lists them.
import { LIMITS } from '../../shared/limits'

/** What sign-in and Better Auth need (auth/auth.ts). */
export type AuthSettings = {
  readonly baseUrl: string
  /** BETTER_AUTH_SECRET: it signs the session cookies and encrypts the signing keys; at least 32 characters. */
  readonly secret: string
  readonly googleClientId: string
  readonly googleClientSecret: string
  /** The verified email that may claim the groups created before accounts existed. */
  readonly bootstrapEmail: string | undefined
  /** New accounts per 24 hours. */
  readonly signUpDailyLimit: number
}

/** What the request handler uses (app.ts). */
export type AppSettings = AuthSettings & {
  /** Report each request's database work in its headers (perf.ts). */
  readonly perfInstrumentation: boolean
}

export type ServerSettings = {
  readonly app: AppSettings
  readonly databaseUrl: string
  readonly poolSize: number
  /** Set in the image, so each start applies new migrations before it takes requests. */
  readonly migrationsDir: string | undefined
  readonly s3: { readonly endpoint: string; readonly region: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string }
  readonly clientDir: string
  readonly host: string
  readonly port: number
  /** AGENTSPLIT_MAINTENANCE: answer 503 (maintenance.ts) and pause the hourly job. */
  readonly maintenance: boolean
}

type Env = Readonly<Record<string, string | undefined>>

/** The settings in `env`. Throws on the first missing or malformed one. */
export function readSettings(env: Env): ServerSettings {
  const optional = (name: string) => env[name]?.trim() || undefined
  const required = (name: string) => {
    const value = optional(name)
    if (!value) throw new Error(`Set ${name}`)
    return value
  }
  const whole = (name: string, fallback: number, what: string) => {
    const text = optional(name)
    if (text === undefined) return fallback
    if (!/^\d+$/.test(text)) throw new Error(`Set ${name} to a whole number of ${what}`)
    return Number(text)
  }
  /** On for true, yes, 1 or on, in any case. */
  const flag = (name: string) => /^(true|yes|1|on)$/i.test(optional(name) ?? '')

  const baseUrl = required('BASE_URL')
  if (!URL.canParse(baseUrl)) throw new Error('Set BASE_URL to the public URL of the app, such as https://agentsplit.example')
  const secret = required('BETTER_AUTH_SECRET')
  if (secret.length < 32) throw new Error('Set BETTER_AUTH_SECRET to at least 32 characters')
  return {
    app: {
      baseUrl,
      secret,
      googleClientId: required('GOOGLE_CLIENT_ID'),
      googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
      bootstrapEmail: optional('AUTH_BOOTSTRAP_EMAIL'),
      signUpDailyLimit: whole('SIGN_UP_DAILY_LIMIT', LIMITS.signUpsPerDay, 'accounts per day'),
      // Off in every deployment; only performance runs set it, as in the current app.
      perfInstrumentation: flag('PERF_INSTRUMENTATION'),
    },
    databaseUrl: required('DATABASE_URL'),
    poolSize: whole('DATABASE_POOL_SIZE', 10, 'connections'),
    migrationsDir: optional('MIGRATIONS_DIR'),
    s3: {
      endpoint: required('S3_UPLOAD_ENDPOINT'),
      region: optional('S3_UPLOAD_REGION') ?? 'garage',
      bucket: optional('S3_UPLOAD_BUCKET') ?? 'agentsplit-receipts',
      accessKeyId: required('S3_UPLOAD_KEY'),
      secretAccessKey: required('S3_UPLOAD_SECRET'),
    },
    clientDir: optional('CLIENT_DIR') ?? 'dist/client',
    host: optional('HOST') ?? '0.0.0.0',
    port: whole('PORT', 3000, 'the port'),
    maintenance: flag('AGENTSPLIT_MAINTENANCE'),
  }
}
