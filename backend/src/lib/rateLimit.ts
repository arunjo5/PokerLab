import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// In-memory fallback for when Upstash isn't configured or is unavailable.

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now()

  // Cheap memory bound: occasionally drop expired buckets.
  if (buckets.size > 5000) {
    buckets.forEach((b, k) => { if (now > b.resetAt) buckets.delete(k) })
  }

  const b = buckets.get(key)
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfter: 0 }
  }
  if (b.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) }
  }
  b.count++
  return { ok: true, retryAfter: 0 }
}

// client ip for rate-limit keys; prefer vercel's platform-set x-real-ip
export function getClientIp(req: Request): string {
  const realIp = (req.headers.get('x-real-ip') || '').trim()
  if (realIp) return realIp
  const first = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  if (first) return first
  return 'unknown'
}

// upstash sliding window, shared across instances; falls back to in-memory above when env vars unset

const hasUpstash = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
)
// one quick retry only; a slow or dead redis must not hold requests
const redis = hasUpstash ? Redis.fromEnv({ retry: { retries: 1, backoff: () => 100 } }) : null

// upstash gets this long to answer; after a failure it's skipped for the cooldown
const UPSTASH_TIMEOUT_MS = 1200
const UPSTASH_COOLDOWN_MS = 60_000
let upstashDownUntil = 0

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('upstash timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

const LIMITS = {
  login: { n: 10, window: '5 m', ms: 5 * 60_000 },
  signup: { n: 8, window: '60 m', ms: 60 * 60_000 },
  signupAll: { n: 20, window: '10 m', ms: 10 * 60_000 },
  // keyed by userId; well above normal auto-save volume
  save: { n: 60, window: '1 m', ms: 60_000 },
  read: { n: 120, window: '1 m', ms: 60_000 },
  billing: { n: 10, window: '10 m', ms: 10 * 60_000 },
  share: { n: 30, window: '1 h', ms: 60 * 60_000 },
} as const

type Kind = keyof typeof LIMITS

const limiters = redis
  ? (Object.fromEntries(
      (Object.keys(LIMITS) as Kind[]).map((k) => [
        k,
        new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(LIMITS[k].n, LIMITS[k].window),
          prefix: `rl:${k}`,
          analytics: false,
        }),
      ])
    ) as Record<Kind, Ratelimit>)
  : null

export async function limit(
  kind: Kind,
  identifier: string
): Promise<{ ok: boolean; retryAfter: number }> {
  if (limiters && Date.now() >= upstashDownUntil) {
    try {
      const { success, reset } = await withTimeout(limiters[kind].limit(identifier), UPSTASH_TIMEOUT_MS)
      return { ok: success, retryAfter: Math.max(0, Math.ceil((reset - Date.now()) / 1000)) }
    } catch (e) {
      // redis down or slow: fall through to in-memory and stop asking for a while
      upstashDownUntil = Date.now() + UPSTASH_COOLDOWN_MS
      console.warn('rate limit: upstash unavailable, using in-memory limits', (e as Error)?.message)
    }
  }
  const cfg = LIMITS[kind]
  return rateLimit(`${kind}:${identifier}`, cfg.n, cfg.ms)
}
