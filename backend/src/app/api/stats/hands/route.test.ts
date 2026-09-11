import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { search: { findMany: vi.fn() } } }))
vi.mock('@/lib/rateLimit', () => ({ limit: vi.fn(async () => ({ ok: true, retryAfter: 0 })) }))
vi.mock('@/lib/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan')>()),
  getPlan: vi.fn(),
}))

import { GET } from '@/app/api/stats/hands/route'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/rateLimit'
import { getPlan, PLAN_LIMITS } from '@/lib/plan'

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>
const findMany = asMock(prisma.search.findMany)

const FREE = { plan: 'free', interval: null, expiresAt: null, saveCap: 25, limits: PLAN_LIMITS.free, hasCustomer: false }
const PRO = { plan: 'pro', interval: 'year', expiresAt: null, saveCap: 5000, limits: PLAN_LIMITS.pro, hasCustomer: true }

const SELECT = { id: true, name: true, createdAt: true, replay: true }
const AT = new Date('2026-01-15T12:00:00.000Z')

const SESSION = { site: 'PokerNow', started: '2026-01-15', hands: 42 }
const STATS = { hero: 2, players: 6, bb: 100, agg: 3, calls: 1, net: -450, pot: 1200, v: 1 }

const row = (id: string, replay: unknown) => ({ id, name: `hand ${id}`, createdAt: AT, replay })
const analysed = (id: string) => row(id, { session: SESSION, stats: STATS })
const page = (n: number) => Array.from({ length: n }, (_, i) => analysed(`h${i + 1}`))

// the route only ever reads request.url
function req(query = '') {
  return { url: `http://x/api/stats/hands${query}`, headers: { get: () => null } } as never
}

const hands = async (res: Response) => (await res.json()).hands
const first = async () => (await hands(await GET(req())))[0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  asMock(auth).mockResolvedValue({ user: { id: 'user1' } })
  asMock(limit).mockResolvedValue({ ok: true, retryAfter: 0 })
  asMock(getPlan).mockResolvedValue(PRO)
  findMany.mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stats hands gates', () => {
  it('401 when unauthenticated', async () => {
    asMock(auth).mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(limit).not.toHaveBeenCalled()
    expect(getPlan).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('401 when the session carries no user id', async () => {
    for (const session of [{}, { user: null }, { user: {} }, { user: { id: '' } }]) {
      asMock(auth).mockResolvedValue(session)
      expect((await GET(req())).status).toBe(401)
    }
  })

  it('429 with Retry-After on the read bucket', async () => {
    asMock(limit).mockResolvedValue({ ok: false, retryAfter: 31 })
    const res = await GET(req())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('31')
    expect(limit).toHaveBeenCalledWith('read', 'user1')
    expect(getPlan).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('403 pro_required for a free user, without reading any rows', async () => {
    asMock(getPlan).mockResolvedValue(FREE)
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Session stats are a Pro feature', code: 'pro_required' })
    expect(getPlan).toHaveBeenCalledWith('user1')
    expect(findMany).not.toHaveBeenCalled()
  })

  it('lets a pro user read', async () => {
    expect((await GET(req())).status).toBe(200)
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})

describe('stats hands query', () => {
  it("asks for the caller's replay rows, newest first, one past the page", async () => {
    await GET(req())
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user1', isReplay: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 101,
      select: SELECT,
    })
  })

  it('keysets past the cursor it was given', async () => {
    await GET(req('?cursor=h42'))
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user1', isReplay: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 101,
      cursor: { id: 'h42' },
      skip: 1,
      select: SELECT,
    })
  })

  it('ignores an empty, missing or unrelated query', async () => {
    await GET(req())
    await GET(req('?cursor='))
    await GET(req('?other=1'))
    for (const call of findMany.mock.calls) {
      expect(call[0].cursor).toBeUndefined()
      expect(call[0].skip).toBeUndefined()
    }
  })

  it('reads only the first cursor when it is repeated', async () => {
    await GET(req('?cursor=h1&cursor=h2'))
    expect(findMany.mock.calls[0][0].cursor).toEqual({ id: 'h1' })
  })

  it('tolerates a request without a url', async () => {
    const res = await GET(undefined as never)
    expect(res.status).toBe(200)
    expect(findMany.mock.calls[0][0].cursor).toBeUndefined()
    expect(findMany.mock.calls[0][0].skip).toBeUndefined()
  })
})

describe('stats hands paging', () => {
  it('returns nothing and no cursor for an empty library', async () => {
    const body = await (await GET(req())).json()
    expect(body).toEqual({ hands: [], nextCursor: null })
  })

  it('returns everything and no cursor below a full page', async () => {
    findMany.mockResolvedValue(page(3))
    const body = await (await GET(req())).json()
    expect(body.hands.map((h: { id: string }) => h.id)).toEqual(['h1', 'h2', 'h3'])
    expect(body.nextCursor).toBeNull()
  })

  it('stops at a hundred with no cursor when exactly a hundred come back', async () => {
    findMany.mockResolvedValue(page(100))
    const body = await (await GET(req())).json()
    expect(body.hands).toHaveLength(100)
    expect(body.nextCursor).toBeNull()
  })

  it('drops the probe row and points the cursor at the last one it kept', async () => {
    findMany.mockResolvedValue(page(101))
    const body = await (await GET(req())).json()
    expect(body.hands).toHaveLength(100)
    expect(body.hands[99].id).toBe('h100')
    expect(body.nextCursor).toBe('h100')
  })
})

describe('stats hands rows', () => {
  it('returns the stored stats and session, and no replay', async () => {
    findMany.mockResolvedValue([row('h1', { session: SESSION, stats: STATS, hands: [{ a: 1 }] })])
    const h = await first()
    expect(h).toEqual({ id: 'h1', name: 'hand h1', createdAt: AT.toISOString(), session: SESSION, stats: STATS })
    expect(h).not.toHaveProperty('replay')
  })

  it('sends the whole replay back when the row has no stats yet', async () => {
    const replay = { session: SESSION, hands: [{ a: 1 }], version: 3 }
    findMany.mockResolvedValue([row('h1', replay)])
    const h = await first()
    expect(h.stats).toBeNull()
    expect(h.session).toEqual(SESSION)
    expect(h.replay).toEqual(replay)
  })

  it('treats a non-object stats field as missing', async () => {
    for (const stats of [null, undefined, 0, 42, '', '{}', true]) {
      const replay = { session: SESSION, stats }
      findMany.mockResolvedValue([row('h1', replay)])
      const h = await first()
      expect(h.stats).toBeNull()
      expect(h.replay).toEqual({ session: SESSION, ...(stats === undefined ? {} : { stats }) })
    }
  })

  it('nulls session, stats and replay when the replay column is not an object', async () => {
    for (const replay of [null, undefined, '', 'x', 0, 42, true, [], [{ a: 1 }]]) {
      findMany.mockResolvedValue([row('h1', replay)])
      const h = await first()
      expect(h.session).toBeNull()
      expect(h.stats).toBeNull()
      expect(h.replay).toBeNull()
    }
  })

  it('nulls a missing or non-object session', async () => {
    for (const session of [null, undefined, '', 'sess', 0, 7, true]) {
      findMany.mockResolvedValue([row('h1', { session, stats: STATS })])
      const h = await first()
      expect(h.session).toBeNull()
      expect(h.stats).toEqual(STATS)
    }
  })

  it('passes the id, name and timestamp straight through', async () => {
    findMany.mockResolvedValue([{ id: 'h1', name: null, createdAt: AT, replay: { stats: STATS } }])
    const h = await first()
    expect(h.id).toBe('h1')
    expect(h.name).toBeNull()
    expect(h.createdAt).toBe(AT.toISOString())
  })

  it('maps each row on its own', async () => {
    const bare = { session: SESSION, hands: [] }
    findMany.mockResolvedValue([analysed('h1'), row('h2', bare), row('h3', 'junk')])
    const list = await hands(await GET(req()))
    expect(list[0]).not.toHaveProperty('replay')
    expect(list[1].replay).toEqual(bare)
    expect(list[2].replay).toBeNull()
  })
})

describe('stats hands failures', () => {
  it('500 when the list query throws', async () => {
    findMany.mockRejectedValue(new Error('db down'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('500 when the plan lookup throws, without reading rows', async () => {
    asMock(getPlan).mockRejectedValue(new Error('db down'))
    expect((await GET(req())).status).toBe(500)
    expect(findMany).not.toHaveBeenCalled()
  })
})
