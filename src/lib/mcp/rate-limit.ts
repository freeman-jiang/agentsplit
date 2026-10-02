/** Per-user token bucket, shared by all that user's keys in this Node process. */
export function createMcpRateLimiter(capacity = 120, periodMs = 60_000) {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>()
  return (userId: string, now = Date.now()): number => {
    // Keep memory bounded by active authenticated users, not supplied IPs/keys.
    for (const [id, bucket] of buckets) {
      if (now - bucket.updatedAt >= periodMs) buckets.delete(id)
    }
    const bucket = buckets.get(userId) ?? { tokens: capacity, updatedAt: now }
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens +
        (Math.max(0, now - bucket.updatedAt) * capacity) / periodMs,
    )
    bucket.updatedAt = now
    buckets.set(userId, bucket)
    if (bucket.tokens < 1)
      return Math.ceil(((1 - bucket.tokens) * periodMs) / capacity / 1000)
    bucket.tokens -= 1
    return 0
  }
}

// The deployed app has one Node process. Multiple replicas need a shared store.
export const limitMcpRequest = createMcpRateLimiter()
