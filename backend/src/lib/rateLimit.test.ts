import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getClientIp } from '@/lib/rateLimit'

// upstash mocks stay inert until the UPSTASH_* env vars are stubbed (hasUpstash gate)
const h = vi.hoisted(() => ({
  upstashLimit: vi.fn(),
  ctors: [] as { prefix: string; n: number; window: string }[],
}))

vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    prefix: string
    constructor(cfg: { prefix: string; limiter: { n: number; window: string } }) {
      h.ctors.push({ prefix: cfg.prefix, n: cfg.limiter.n, window: cfg.limiter.window })
      this.prefix = cfg.prefix
    }
    limit(id: string) {
      return h.upstashLimit(this.prefix, id)
    }
    static slidingWindow(n: number, window: string) {
      return { n, window }
    }
  }
  return { Ratelimit }
})
vi.mock('@upstash/redis', () => ({ Redis: { fromEnv: () => ({}) } }))

// rateLimit.ts holds module-level state (bucket map, env-gated limiters),
// so every test imports a fresh copy.
async function load(withUpstash = false) {
  vi.resetModules()
  h.ctors.length = 0
  if (withUpstash) {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.io')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok')
  } else {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined)
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined)
  }
  return await import('@/lib/rateLimit')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

function req(headers: Record<string, string>): Request {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Request
}

describe('getClientIp', () => {
  it('prefers the platform x-real-ip over x-forwarded-for', () => {
    expect(
      getClientIp(req({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))
    ).toBe('9.9.9.9')
  })

  it('falls back to the first x-forwarded-for entry when no x-real-ip', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1')
  })

  it('trims surrounding whitespace', () => {
    expect(getClientIp(req({ 'x-real-ip': '  5.5.5.5  ' }))).toBe('5.5.5.5')
  })

  it('returns "unknown" when no ip headers are present', () => {
    expect(getClientIp(req({}))).toBe('unknown')
  })
})

describe('getClientIp degenerate and adversarial headers', () => {
  it('falls back to x-forwarded-for when x-real-ip is the empty string', () => {
    expect(getClientIp(req({ 'x-real-ip': '', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' }))).toBe('3.3.3.3')
  })

  it('falls back to x-forwarded-for for a whitespace-only x-real-ip', () => {
    expect(getClientIp(req({ 'x-real-ip': '   ', 'x-forwarded-for': '3.3.3.3' }))).toBe('3.3.3.3')
  })

  it('trims spaces around the first x-forwarded-for entry', () => {
    expect(getClientIp(req({ 'x-forwarded-for': ' 1.1.1.1 , 2.2.2.2' }))).toBe('1.1.1.1')
  })

  it('falls back to unknown for a leading-comma x-forwarded-for', () => {
    expect(getClientIp(req({ 'x-forwarded-for': ',2.2.2.2' }))).toBe('unknown')
    expect(getClientIp(req({ 'x-forwarded-for': ',' }))).toBe('unknown')
  })

  it('ignores attacker-controlled x-forwarded-for whenever x-real-ip exists', () => {
    expect(getClientIp(req({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': 'evil, 8.8.8.8' }))).toBe('9.9.9.9')
  })
})

describe('rateLimit() in-memory fixed window', () => {
  it('allows the first `limit` calls and blocks the next within one window', async () => {
    const { rateLimit } = await load()
    expect(rateLimit('k', 3, 60_000)).toEqual({ ok: true, retryAfter: 0 })
    expect(rateLimit('k', 3, 60_000)).toEqual({ ok: true, retryAfter: 0 })
    expect(rateLimit('k', 3, 60_000)).toEqual({ ok: true, retryAfter: 0 })
    expect(rateLimit('k', 3, 60_000).ok).toBe(false)
  })

  it('rounds retryAfter up to whole seconds', async () => {
    const { rateLimit } = await load()
    vi.setSystemTime(1_000_000)
    for (let i = 0; i < 3; i++) rateLimit('k', 3, 60_000)
    vi.setSystemTime(1_000_000 + 58_500) // 1500ms left -> ceil to 2
    expect(rateLimit('k', 3, 60_000)).toEqual({ ok: false, retryAfter: 2 })
  })

  it('still blocks at exactly resetAt and resets one ms after', async () => {
    const { rateLimit } = await load()
    vi.setSystemTime(1_000_000)
    for (let i = 0; i < 3; i++) rateLimit('k', 3, 60_000)
    vi.setSystemTime(1_060_000) // now === resetAt: old bucket still applies
    expect(rateLimit('k', 3, 60_000).ok).toBe(false)
    vi.setSystemTime(1_060_001)
    expect(rateLimit('k', 3, 60_000)).toEqual({ ok: true, retryAfter: 0 })
  })

  it('restores the full quota after the window expires', async () => {
    const { rateLimit } = await load()
    vi.setSystemTime(0)
    for (let i = 0; i < 3; i++) rateLimit('k', 3, 60_000)
    expect(rateLimit('k', 3, 60_000).ok).toBe(false)
    vi.setSystemTime(60_001)
    expect(rateLimit('k', 3, 60_000).ok).toBe(true)
    expect(rateLimit('k', 3, 60_000).ok).toBe(true)
    expect(rateLimit('k', 3, 60_000).ok).toBe(true)
    expect(rateLimit('k', 3, 60_000).ok).toBe(false)
  })

  it('isolates keys from each other', async () => {
    const { rateLimit } = await load()
    for (let i = 0; i < 3; i++) rateLimit('a', 3, 60_000)
    expect(rateLimit('a', 3, 60_000).ok).toBe(false)
    expect(rateLimit('b', 3, 60_000).ok).toBe(true)
  })

  it('sweeps expired buckets past the 5000-bucket bound without touching live ones', async () => {
    const { rateLimit } = await load()
    vi.setSystemTime(0)
    for (let i = 0; i < 5001; i++) rateLimit(`expired-${i}`, 1, 1_000)
    rateLimit('live', 3, 100_000)
    rateLimit('live', 3, 100_000) // live bucket at count 2
    vi.setSystemTime(5_000) // expired-* past resetAt, live not
    expect(rateLimit('trigger', 1, 1_000).ok).toBe(true) // size > 5000 -> sweep
    // live bucket survived the sweep with its count intact
    expect(rateLimit('live', 3, 100_000).ok).toBe(true)
    expect(rateLimit('live', 3, 100_000).ok).toBe(false)
    // swept keys start a fresh window
    expect(rateLimit('expired-0', 1, 1_000).ok).toBe(true)
  })
})

describe('limit() dispatcher (in-memory fallback)', () => {
  it('prefixes bucket keys by kind so kinds never share buckets', async () => {
    const { limit } = await load()
    vi.setSystemTime(0)
    for (let i = 0; i < 10; i++) expect((await limit('login', 'u1')).ok).toBe(true)
    // blocked with the login window's retryAfter, verbatim from rateLimit()
    expect(await limit('login', 'u1')).toEqual({ ok: false, retryAfter: 300 })
    expect((await limit('save', 'u1')).ok).toBe(true)
  })

  it('applies each kind\'s configured limit', async () => {
    const { limit } = await load()
    const KINDS = [
      ['login', 10],
      ['signup', 8],
      ['signupAll', 20],
      ['save', 60],
      ['read', 120],
      ['billing', 10],
      ['share', 30],
    ] as const
    for (const [kind, n] of KINDS) {
      for (let i = 0; i < n; i++) expect((await limit(kind, 'id')).ok).toBe(true)
      expect((await limit(kind, 'id')).ok).toBe(false)
    }
  })
})

describe('limit() with upstash configured', () => {
  it('constructs one limiter per kind with an rl:<kind> prefix and the configured size', async () => {
    await load(true)
    const byPrefix = Object.fromEntries(h.ctors.map((c) => [c.prefix, [c.n, c.window]]))
    expect(byPrefix).toEqual({
      'rl:login': [10, '5 m'],
      'rl:signup': [8, '60 m'],
      'rl:signupAll': [20, '10 m'],
      'rl:save': [60, '1 m'],
      'rl:read': [120, '1 m'],
      'rl:billing': [10, '10 m'],
      'rl:share': [30, '1 h'],
    })
  })

  it('keeps the upstash window strings consistent with the in-memory windows', async () => {
    await load(true)
    const captured = h.ctors.map((c) => ({ kind: c.prefix.slice(3), n: c.n, window: c.window }))
    expect(captured).toHaveLength(7)
    const UNIT: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 }
    const { limit } = await load() // fresh module, no upstash
    for (const { kind, n, window } of captured) {
      const [count, unit] = window.split(' ')
      const ms = Number(count) * UNIT[unit]
      expect(ms).toBeGreaterThan(0)
      const k = kind as Parameters<typeof limit>[0]
      vi.setSystemTime(0)
      for (let i = 0; i < n; i++) expect((await limit(k, 'w')).ok).toBe(true)
      expect((await limit(k, 'w')).ok).toBe(false)
      vi.setSystemTime(ms) // boundary: still inside the window
      expect((await limit(k, 'w')).ok).toBe(false)
      vi.setSystemTime(ms + 1)
      expect((await limit(k, 'w')).ok).toBe(true)
    }
  })

  it('maps upstash success/reset to ok/retryAfter', async () => {
    vi.setSystemTime(1_000_000)
    const { limit } = await load(true)
    h.upstashLimit.mockResolvedValue({ success: false, reset: 1_005_000 })
    expect(await limit('login', 'ip1')).toEqual({ ok: false, retryAfter: 5 })
    expect(h.upstashLimit).toHaveBeenCalledWith('rl:login', 'ip1')
    h.upstashLimit.mockResolvedValue({ success: true, reset: 1_002_500 })
    expect(await limit('save', 'u2')).toEqual({ ok: true, retryAfter: 3 })
    expect(h.upstashLimit).toHaveBeenLastCalledWith('rl:save', 'u2')
  })

  it('clamps a stale upstash reset to retryAfter 0', async () => {
    vi.setSystemTime(1_000_000)
    const { limit } = await load(true)
    h.upstashLimit.mockResolvedValue({ success: false, reset: 999_999 })
    expect(await limit('login', 'ip1')).toEqual({ ok: false, retryAfter: 0 })
  })

  it('falls back to the in-memory limiter when redis throws, still enforcing the limit', async () => {
    const { limit } = await load(true)
    h.upstashLimit.mockRejectedValue(new Error('redis down'))
    for (let i = 0; i < 10; i++) expect((await limit('login', 'u9')).ok).toBe(true)
    expect((await limit('login', 'u9')).ok).toBe(false)
  })
})

describe('limit() when upstash is slow or down', () => {
  it('falls back to memory after the timeout, then skips upstash for the cooldown', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { limit } = await load(true)
      h.upstashLimit.mockImplementation(() => new Promise(() => {})) // never answers
      const pending = limit('read', 'id')
      await vi.advanceTimersByTimeAsync(1200)
      expect(await pending).toEqual({ ok: true, retryAfter: 0 })
      expect(h.upstashLimit).toHaveBeenCalledTimes(1)
      // breaker open: straight to memory
      expect(await limit('read', 'id')).toEqual({ ok: true, retryAfter: 0 })
      expect(h.upstashLimit).toHaveBeenCalledTimes(1)
      // and upstash is tried again once the cooldown passes
      await vi.advanceTimersByTimeAsync(60_000)
      h.upstashLimit.mockResolvedValue({ success: true, reset: Date.now() + 1000 })
      await limit('read', 'id')
      expect(h.upstashLimit).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('a rejected upstash call trips the breaker at once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { limit } = await load(true)
      h.upstashLimit.mockRejectedValue(new Error('fetch failed'))
      expect((await limit('read', 'id')).ok).toBe(true)
      await limit('read', 'id')
      expect(h.upstashLimit).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
