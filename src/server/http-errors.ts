// The JSON error answers of the plain HTTP routes, as the current app answers.
import { ERROR_ANSWERS, errorKind, errorText } from '../shared/errors'
import { isDomainError } from './calls'

export const noStore = { 'Cache-Control': 'no-store' } as const

/** A JSON error body `{error}`, kept out of caches. */
export const jsonError = (data: { status: number; message: string; headers?: Record<string, string> }) =>
  Response.json({ error: data.message }, { status: data.status, headers: { ...noStore, ...data.headers } })

/** The answer of a domain error on a plain HTTP route, from the error registry (src/shared/errors.ts). Anything else is rethrown. */
export function domainErrorResponse(error: unknown): Response {
  if (!isDomainError(error)) throw error
  return jsonError({ status: ERROR_ANSWERS[errorKind(error)].http, message: errorText(error) })
}
