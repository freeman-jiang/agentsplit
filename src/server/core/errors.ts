// The errors the domain code throws on purpose, and their JSON answers on the
// plain HTTP routes, as the current app answers.
import { Conflict, Forbidden, Invalid, NotFound } from '../../shared/api'
import { ERROR_ANSWERS, errorKind, errorText } from '../../shared/errors'

/** Errors the domain code throws on purpose. */
export type DomainError = Forbidden | NotFound | Conflict | Invalid

export const isDomainError = (error: unknown): error is DomainError =>
  error instanceof Forbidden || error instanceof NotFound || error instanceof Conflict || error instanceof Invalid

export const noStore = { 'Cache-Control': 'no-store' } as const

/** A JSON error body `{error}`, kept out of caches. */
export const jsonError = (data: { status: number; message: string; headers?: Record<string, string> }) =>
  Response.json({ error: data.message }, { status: data.status, headers: { ...noStore, ...data.headers } })

/** The answer of a domain error on a plain HTTP route, from the error registry (src/shared/errors.ts). Anything else is rethrown. */
export function domainErrorResponse(error: unknown): Response {
  if (!isDomainError(error)) throw error
  return jsonError({ status: ERROR_ANSWERS[errorKind(error)].http, message: errorText(error) })
}
