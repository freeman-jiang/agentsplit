import { apiKeyClient } from '@better-auth/api-key/client'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/client'
import { describeError } from './errors'

/**
 * Sign-in, sign-out, API key creation and OAuth consent. The OAuth provider
 * plugin adds the signed authorization query of the current page to each
 * request, so a sign-in started from an agent's authorize redirect resumes
 * at the consent page. Import it only from screen components, which are
 * code-split, so that it stays out of the main bundle.
 */
export const authClient = createAuthClient({ plugins: [apiKeyClient(), oauthProviderClient()] })

type AuthResult<T> = { readonly data: T | null; readonly error: { readonly message?: string | undefined } | null }

/**
 * Runs one Better Auth call. A refusal, or an answer without data, shows
 * Better Auth's message, else `refused`; a call that throws (no answer) is
 * logged and shows `failed`.
 */
export async function authCall<T>(data: { run: () => Promise<AuthResult<T>>; refused: string; failed: string }): Promise<{ readonly data: T } | { readonly error: string }> {
  try {
    const result = await data.run()
    if (result.data !== null && !result.error) return { data: result.data }
    return { error: result.error ? describeError(result.error, data.refused).message : data.refused }
  } catch (cause) {
    console.error('Better Auth call failed', cause)
    return { error: data.failed }
  }
}
