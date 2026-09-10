import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  customersCreate: vi.fn(),
  sessionsCreate: vi.fn(),
}))

vi.mock('@/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: vi.fn(), update: vi.fn() } } }))
vi.mock('@/lib/rateLimit', () => ({ limit: vi.fn(async () => ({ ok: true, retryAfter: 0 })) }))
vi.mock('@/lib/stripe', () => ({
  stripe: () => ({
    customers: { create: h.customersCreate },
    checkout: { sessions: { create: h.sessionsCreate } },
  }),
  priceId: vi.fn(),
  billingEnabled: vi.fn(),
  appUrl: vi.fn(),
}))

import { POST } from '@/app/api/billing/checkout/route'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/rateLimit'
import { priceId, billingEnabled, appUrl } from '@/lib/stripe'

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>
const findUnique = asMock(prisma.user.findUnique)
const update = asMock(prisma.user.update)

function req(body: unknown = {}, headers: Record<string, string> = {}): Request {
  const json = JSON.stringify(body)
  const hdrs: Record<string, string> = { 'content-length': String(Buffer.byteLength(json, 'utf8')), ...headers }
  return {
    headers: { get: (k: string) => hdrs[k.toLowerCase()] ?? null },
    text: async () => json,
  } as unknown as Request
}

const FREE_USER = {
  id: 'user1',
  name: 'Ada',
  email: 'ada',
  plan: 'free',
  planExpiresAt: null,
  stripeCustomerId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0))
  asMock(auth).mockResolvedValue({ user: { id: 'user1' } })
  asMock(limit).mockResolvedValue({ ok: true, retryAfter: 0 })
  asMock(billingEnabled).mockReturnValue(true)
  asMock(appUrl).mockReturnValue('https://pokerlab.app')
  asMock(priceId).mockImplementation((i: string) => (i === 'year' ? 'price_year' : 'price_month'))
  findUnique.mockResolvedValue(FREE_USER)
  update.mockResolvedValue({})
  h.customersCreate.mockResolvedValue({ id: 'cus_new' })
  h.sessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('checkout POST gates', () => {
  it('403 on a cross-site request, before any auth work', async () => {
    const res = await POST(req({}, { 'sec-fetch-site': 'cross-site' }) as never)
    expect(res.status).toBe(403)
    expect(auth).not.toHaveBeenCalled()
    expect(h.sessionsCreate).not.toHaveBeenCalled()
  })

  it('lets benign sec-fetch-site values through', async () => {
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect((await POST(req({}, { 'sec-fetch-site': site }) as never)).status).toBe(200)
    }
  })

  it('401 when unauthenticated', async () => {
    asMock(auth).mockResolvedValue(null)
    expect((await POST(req() as never)).status).toBe(401)
    expect(limit).not.toHaveBeenCalled()
  })

  it('429 with Retry-After on the billing bucket', async () => {
    asMock(limit).mockResolvedValue({ ok: false, retryAfter: 42 })
    const res = await POST(req() as never)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    expect(limit).toHaveBeenCalledWith('billing', 'user1')
    expect(h.sessionsCreate).not.toHaveBeenCalled()
  })

  it('503 when billing is not configured', async () => {
    asMock(billingEnabled).mockReturnValue(false)
    const res = await POST(req() as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Billing is not configured' })
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('400 on a non-JSON body', async () => {
    const bad = {
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '5' : null) },
      text: async () => 'nope!',
    } as unknown as Request
    const res = await POST(bad as never)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid JSON')
  })

  it('413 past the 1KB body cap', async () => {
    expect((await POST(req({ interval: 'x'.repeat(1100) }) as never)).status).toBe(413)
  })

  it('401 when the session user has no row', async () => {
    findUnique.mockResolvedValue(null)
    expect((await POST(req() as never)).status).toBe(401)
    expect(h.customersCreate).not.toHaveBeenCalled()
  })

  it('409 when the user is already on pro', async () => {
    findUnique.mockResolvedValue({ ...FREE_USER, plan: 'pro', planExpiresAt: new Date(Date.now() + 86_400_000) })
    const res = await POST(req() as never)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already on Pro' })
    expect(h.sessionsCreate).not.toHaveBeenCalled()
  })

  it('409 for a lapsed pro still inside the grace', async () => {
    const justInside = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 1000)
    findUnique.mockResolvedValue({ ...FREE_USER, plan: 'pro', planExpiresAt: justInside })
    expect((await POST(req() as never)).status).toBe(409)
  })

  it('lets a pro past the grace re-subscribe', async () => {
    const pastGrace = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 1000)
    findUnique.mockResolvedValue({ ...FREE_USER, plan: 'pro', planExpiresAt: pastGrace })
    expect((await POST(req() as never)).status).toBe(200)
    expect(h.sessionsCreate).toHaveBeenCalledTimes(1)
  })
})

describe('checkout POST interval', () => {
  it('uses the monthly price only when the body asks for month', async () => {
    await POST(req({ interval: 'month' }) as never)
    expect(priceId).toHaveBeenCalledWith('month')
    expect(h.sessionsCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_month', quantity: 1 }])
  })

  it.each([
    ['year', { interval: 'year' }],
    ['no interval', {}],
    ['a junk interval', { interval: 'week' }],
    ['a non-string interval', { interval: 12 }],
  ])('defaults to yearly for %s', async (_label, body) => {
    await POST(req(body) as never)
    expect(priceId).toHaveBeenCalledWith('year')
    expect(h.sessionsCreate.mock.calls[0][0].line_items).toEqual([{ price: 'price_year', quantity: 1 }])
  })
})

describe('checkout POST customer', () => {
  it('lets checkout create the customer on a first purchase, with no stripe customer call', async () => {
    await POST(req() as never)
    expect(h.customersCreate).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    const args = h.sessionsCreate.mock.calls[0][0]
    expect(args.customer).toBeUndefined()
    expect(args.customer_email).toBeUndefined() // the column holds a username
  })

  it('prefills a real email address', async () => {
    findUnique.mockResolvedValue({ ...FREE_USER, email: 'ada@example.com' })
    await POST(req() as never)
    expect(h.sessionsCreate.mock.calls[0][0].customer_email).toBe('ada@example.com')
  })

  it('reuses an existing stripe customer', async () => {
    findUnique.mockResolvedValue({ ...FREE_USER, stripeCustomerId: 'cus_old' })
    await POST(req() as never)
    expect(h.customersCreate).not.toHaveBeenCalled()
    const args = h.sessionsCreate.mock.calls[0][0]
    expect(args.customer).toBe('cus_old')
    expect(args.customer_email).toBeUndefined()
  })
})

describe('checkout POST session', () => {
  it('builds the subscription session and returns its url', async () => {
    const res = await POST(req({ interval: 'month' }) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' })
    expect(h.sessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer_email: undefined,
      line_items: [{ price: 'price_month', quantity: 1 }],
      success_url: 'https://pokerlab.app/?billing=success',
      cancel_url: 'https://pokerlab.app/?billing=cancel',
      client_reference_id: 'user1',
      metadata: { userId: 'user1' },
      subscription_data: { metadata: { userId: 'user1' } },
      allow_promotion_codes: true,
    })
  })

  it('builds return urls off appUrl', async () => {
    asMock(appUrl).mockReturnValue('http://localhost:5173')
    await POST(req() as never)
    const args = h.sessionsCreate.mock.calls[0][0]
    expect(args.success_url).toBe('http://localhost:5173/?billing=success')
    expect(args.cancel_url).toBe('http://localhost:5173/?billing=cancel')
  })

  it('500 when stripe returns a session with no url', async () => {
    h.sessionsCreate.mockResolvedValue({ id: 'cs_1', url: null })
    const res = await POST(req() as never)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not start checkout' })
  })

  it('500 when the session call throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.sessionsCreate.mockRejectedValue(new Error('stripe down'))
    const res = await POST(req() as never)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('500 when the customer lookup throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    findUnique.mockRejectedValue(new Error('db down'))
    expect((await POST(req() as never)).status).toBe(500)
  })
})
