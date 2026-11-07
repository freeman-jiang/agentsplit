// Waiting on a condition instead of a fixed time.

/** Polls `condition` until it holds; throws after `timeoutMs`. */
export async function waitFor(condition: () => Promise<boolean>, data: { what: string; timeoutMs?: number } = { what: 'the condition' }): Promise<void> {
  const deadline = Date.now() + (data.timeoutMs ?? 5_000)
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${data.what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
