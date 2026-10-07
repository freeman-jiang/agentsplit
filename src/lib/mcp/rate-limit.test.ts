/** @jest-environment node */
import { createMcpRateLimiter } from './rate-limit'

it('shares a user budget across calls, refills continuously, and isolates users', () => {
  const consume = createMcpRateLimiter(2, 10_000)
  expect(consume('alice', 0)).toBe(0)
  expect(consume('alice', 0)).toBe(0)
  expect(consume('alice', 0)).toBe(5)
  expect(consume('bob', 0)).toBe(0)
  expect(consume('alice', 4_000)).toBe(1)
  expect(consume('alice', 5_000)).toBe(0)
  expect(consume('alice', 5_000)).toBe(5)
  expect(consume('alice', 15_000)).toBe(0)
  expect(consume('alice', 15_000)).toBe(0)
  expect(consume('alice', 15_000)).toBe(5)
})
