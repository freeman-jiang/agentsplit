/** The Worker's bindings, from wrangler.jsonc and `wrangler secret put`. */
export interface Env {
  readonly ASSETS: Fetcher
  readonly HYPERDRIVE: Hyperdrive
  readonly RECEIPTS: R2Bucket
  readonly BASE_URL: string
  readonly BETTER_AUTH_SECRET: string
  readonly GOOGLE_CLIENT_ID: string
  readonly GOOGLE_CLIENT_SECRET: string
  /** The verified email that may claim the groups created before accounts existed. */
  readonly AUTH_BOOTSTRAP_EMAIL?: string
  /** "true", "yes", "1" or "on" shows receipts on expenses, as in the current app. */
  readonly ENABLE_EXPENSE_DOCUMENTS?: string
}
