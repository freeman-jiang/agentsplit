// The settings of an app in process: test-only values that pass the start checks (core/config.ts).
import type { AppSettings } from '../../src/server/core/config'
import { LIMITS } from '../../src/shared/limits'

export const BASE = 'http://localhost'
export const SECRET = 'test-secret-0123456789-0123456789-0123456789'

export const testSettings = (over: Partial<AppSettings> = {}): AppSettings => ({
  baseUrl: BASE,
  secret: SECRET,
  googleClientId: 'test-google',
  googleClientSecret: 'test-google-secret',
  bootstrapEmail: undefined,
  signUpDailyLimit: LIMITS.signUpsPerDay,
  perfInstrumentation: false,
  maintenance: false,
  receiptDownloads: { mode: 'stream' },
  ...over,
})
