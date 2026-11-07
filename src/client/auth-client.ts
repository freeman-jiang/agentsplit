import { apiKeyClient } from '@better-auth/api-key/client'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/client'

/**
 * Sign-in, sign-out, API key creation and OAuth consent. The OAuth provider
 * plugin adds the signed authorization query of the current page to each
 * request, so a sign-in started from an agent's authorize redirect resumes
 * at the consent page. Import it only from screen components, which are
 * code-split, so that it stays out of the main bundle.
 */
export const authClient = createAuthClient({ plugins: [apiKeyClient(), oauthProviderClient()] })
