// IDs for test rows. Each file names its own rows; these keep them unique.

/** A counter of IDs: `<prefix>-1`, `<prefix>-2`, … */
export function counter(prefix: string): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

/** A 21-character ID, the length of the app's IDs: `prefix` and `n` padded with zeros. */
export const id21 = (prefix: string, n: number) => `${prefix}${String(n).padStart(21 - prefix.length, '0')}`
