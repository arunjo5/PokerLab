import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: { search: { createMany: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() } },
}))
vi.mock('@/lib/plan', () => ({ getPlan: vi.fn() }))
vi.mock('@/lib/rateLimit', () => ({ limit: vi.fn() }))

import { POST } from '@/app/api/searches/import/route'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/rateLimit'
import { getPlan } from '@/lib/plan'

const mock = (f: unknown) => f as ReturnType<typeof vi.fn>

function req(body: unknown, headers: Record<string, string> = {}): Request {
  const json = JSON.stringify(body)
  const h: Record<string, string> = { 'content-length': String(Buffer.byteLength(json, 'utf8')), ...headers }
  return {
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
    text: async () => json,
  } as unknown as Request
}

const item = (extra: Record<string, unknown> = {}) => ({ players: [null, null], board: [], odds: {}, ...extra })

const post = (items: unknown, headers?: Record<string, string>) =>
  POST(req({ items }, headers) as never)

const arg = () => mock(prisma.search.createMany).mock.calls[0][0]
const rows = () => arg().data as Record<string, unknown>[]
const err = async (res: Response) => (await res.json()).error

const FREE = { plan: 'free', saveCap: 25, interval: null, expiresAt: null, hasCustomer: false }
const PRO = { plan: 'pro', saveCap: 5000, interval: 'year', expiresAt: null, hasCustomer: true }

beforeEach(() => {
  vi.clearAllMocks()
  mock(auth).mockResolvedValue({ user: { id: 'user1' } })
  mock(limit).mockResolvedValue({ ok: true, retryAfter: 0 })
  mock(getPlan).mockResolvedValue(FREE)
  mock(prisma.search.createMany).mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
  mock(prisma.search.findMany).mockResolvedValue([])
  mock(prisma.search.deleteMany).mockResolvedValue({ count: 0 })
  mock(prisma.search.count).mockResolvedValue(0)
})

describe('import gate', () => {
  it('403 on a cross-site request, before any auth work', async () => {
    const res = await post([item()], { 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(403)
    expect(auth).not.toHaveBeenCalled()
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('401 when unauthenticated', async () => {
    mock(auth).mockResolvedValue(null)
    const res = await post([item()])
    expect(res.status).toBe(401)
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('429 with Retry-After on the save limiter, before any write', async () => {
    mock(limit).mockResolvedValue({ ok: false, retryAfter: 30 })
    const res = await post([item()])
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(limit).toHaveBeenCalledWith('save', 'user1')
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('benign sec-fetch-site values pass through', async () => {
    for (const site of ['same-site', 'same-origin']) {
      expect((await post([item()], { 'sec-fetch-site': site })).status).toBe(200)
    }
  })
})

describe('import body', () => {
  it('413 on a declared or buffered body over the cap', async () => {
    const declared = await post([item()], { 'content-length': String(1024 * 1024 + 1) })
    expect(declared.status).toBe(413)
    // content-length lies, so the size check has to catch it after buffering
    const big = {
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '10' : null) },
      text: async () => 'a'.repeat(1024 * 1024 + 1),
    } as unknown as Request
    expect((await POST(big as never)).status).toBe(413)
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('400 on a non-JSON body', async () => {
    const bad = {
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? '5' : null) },
      text: async () => 'nope!',
    } as unknown as Request
    const res = await POST(bad as never)
    expect(res.status).toBe(400)
    expect(await err(res)).toBe('Invalid JSON')
  })
})

describe('import items envelope', () => {
  it('400 when items is missing, not an array or empty', async () => {
    for (const items of [undefined, null, {}, 'x', 7, []]) {
      const res = await post(items)
      expect(res.status).toBe(400)
      expect(await err(res)).toBe('Invalid items')
    }
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('400 for 26 items', async () => {
    const res = await post(new Array(26).fill(item()))
    expect(res.status).toBe(400)
    expect(await err(res)).toBe('Invalid items')
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('accepts a full batch of 25', async () => {
    const res = await post(new Array(25).fill(item()))
    expect(res.status).toBe(200)
    expect(rows()).toHaveLength(25)
  })
})

describe('import item validation', () => {
  const reject = async (it: unknown, message: string) => {
    const res = await post([it])
    expect(res.status, JSON.stringify(it)?.slice(0, 60)).toBe(400)
    expect(await err(res)).toBe(message)
  }

  it('400 for items that are not plain objects', async () => {
    for (const bad of [null, 'x', 7, [], true]) await reject(bad, 'Invalid item')
  })

  it('400 for a missing, non-array or oversized players list', async () => {
    await reject({ board: [], odds: {} }, 'Invalid players')
    await reject(item({ players: 'AA' }), 'Invalid players')
    await reject(item({ players: new Array(10).fill(null) }), 'Invalid players')
  })

  it('400 for a missing, non-array or oversized board', async () => {
    await reject({ players: [], odds: {} }, 'Invalid board')
    await reject(item({ board: {} }), 'Invalid board')
    await reject(item({ board: new Array(6).fill(null) }), 'Invalid board')
  })

  it('400 when odds is missing, null, an array or a scalar', async () => {
    await reject({ players: [], board: [] }, 'Invalid odds')
    await reject(item({ odds: null }), 'Invalid odds')
    await reject(item({ odds: [1, 2] }), 'Invalid odds')
    await reject(item({ odds: 'x' }), 'Invalid odds')
  })

  it('400 for a non-string or oversized name, accepting 200 chars', async () => {
    await reject(item({ name: 42 }), 'Invalid name')
    await reject(item({ name: 'x'.repeat(201) }), 'Invalid name')
    expect((await post([item({ name: 'x'.repeat(200) })])).status).toBe(200)
  })

  it('validates the playerNames list and stores a valid one', async () => {
    await reject(item({ playerNames: 'alice' }), 'Invalid playerNames')
    await reject(item({ playerNames: new Array(10).fill('a') }), 'Invalid playerNames')
    await reject(item({ playerNames: ['x'.repeat(101)] }), 'Invalid playerNames')
    await reject(item({ playerNames: [7] }), 'Invalid playerNames')
    expect(prisma.search.createMany).not.toHaveBeenCalled()
    expect((await post([item({ playerNames: [null, 'x'.repeat(100)] })])).status).toBe(200)
    expect(rows()[0].playerNames).toEqual([null, 'x'.repeat(100)])
  })

  it('400 when a serialized field blows its size limit', async () => {
    await reject(item({ players: [{ x: 'a'.repeat(17000) }] }), 'Field too large')
    await reject(item({ board: [{ x: 'a'.repeat(2100) }] }), 'Field too large')
    await reject(item({ odds: { x: 'a'.repeat(17000) } }), 'Field too large')
    await reject(item({ replay: { x: 'a'.repeat(50000) } }), 'Field too large')
    expect((await post([item({ replay: { x: 'a'.repeat(49000) } })])).status).toBe(200)
  })

  it('one bad item anywhere blocks the whole batch', async () => {
    for (const at of [0, 1, 2]) {
      mock(prisma.search.createMany).mockClear()
      const batch = [item(), item(), item()]
      batch[at] = item({ board: new Array(6).fill(null) })
      const res = await post(batch)
      expect(res.status, `bad at ${at}`).toBe(400)
      expect(await err(res)).toBe('Invalid board')
      expect(prisma.search.createMany).not.toHaveBeenCalled()
    }
    // and the first failure wins, not the last
    expect(await err(await post([item({ players: 'AA' }), item({ board: 'x' })]))).toBe('Invalid players')
  })
})

describe('import handId', () => {
  it('stores null when handId is absent or null', async () => {
    await post([item(), item({ handId: null })])
    expect(rows()[0].handId).toBeNull()
    expect(rows()[1].handId).toBeNull()
  })

  it('400 for an empty or non-string handId', async () => {
    for (const handId of ['', 42, {}, true]) {
      const res = await post([item({ handId })])
      expect(res.status).toBe(400)
      expect(await err(res)).toBe('Invalid handId')
    }
    expect(prisma.search.createMany).not.toHaveBeenCalled()
  })

  it('accepts 100 chars and rejects 101', async () => {
    expect((await post([item({ handId: 'h'.repeat(100) })])).status).toBe(200)
    expect(rows()[0].handId).toBe('h'.repeat(100))
    const res = await post([item({ handId: 'h'.repeat(101) })])
    expect(res.status).toBe(400)
    expect(await err(res)).toBe('Invalid handId')
  })
})

describe('import row mapping', () => {
  it('scopes every row to the session user', async () => {
    await post([item(), item()])
    expect(rows().map((r) => r.userId)).toEqual(['user1', 'user1'])
  })

  it('cleans the name and defaults it to null', async () => {
    await post([item({ name: 'Na' + String.fromCharCode(0x200b) + 'me' }), item()])
    expect(rows()[0].name).toBe('Name')
    expect(rows()[1].name).toBeNull()
  })

  it('coerces isReplay and favorite to booleans', async () => {
    await post([item({ isReplay: 1, favorite: 'yes' }), item()])
    expect(rows()[0].isReplay).toBe(true)
    expect(rows()[0].favorite).toBe(true)
    expect(rows()[1].isReplay).toBe(false)
    expect(rows()[1].favorite).toBe(false)
  })

  it('passes the json fields through, defaulting replay and playerNames to null', async () => {
    await post([item({ players: [{ kind: 'range' }], board: [{ v: 'A', s: 's' }], odds: { 0: { win: 1 } }, replay: { steps: [] } }), item()])
    expect(rows()[0]).toMatchObject({
      players: [{ kind: 'range' }],
      board: [{ v: 'A', s: 's' }],
      odds: { 0: { win: 1 } },
      replay: { steps: [] },
    })
    expect(rows()[1].replay).toBeNull()
    expect(rows()[1].playerNames).toBeNull()
  })

  it('passes skipDuplicates so a re-imported log inserts nothing', async () => {
    await post([item({ handId: 'h1' })])
    expect(arg().skipDuplicates).toBe(true)
    expect(prisma.search.createMany).toHaveBeenCalledTimes(1)
  })

  it('spreads timestamps one millisecond apart in item order, mirrored into lastAccessedAt', async () => {
    await post([item(), item(), item()])
    const at = rows().map((r) => (r.createdAt as Date).getTime())
    expect(at[1]).toBe(at[0] + 1)
    expect(at[2]).toBe(at[1] + 1)
    expect(new Set(at).size).toBe(3)
    for (const r of rows()) {
      expect(r.lastAccessedAt).toBeInstanceOf(Date)
      expect((r.lastAccessedAt as Date).getTime()).toBe((r.createdAt as Date).getTime())
    }
  })
})

describe('import prune', () => {
  it('orders the prune scan favorites-first then by recency, skipping the cap', async () => {
    expect((await post([item()])).status).toBe(200)
    expect(mock(prisma.search.findMany).mock.calls[0][0]).toEqual({
      where: { userId: 'user1' },
      orderBy: [{ favorite: 'desc' }, { lastAccessedAt: 'desc' }, { createdAt: 'desc' }],
      skip: 25,
      select: { id: true },
    })
  })

  it('deletes exactly the stale rows past the cap', async () => {
    mock(prisma.search.findMany).mockResolvedValue([{ id: 'old1' }, { id: 'old2' }])
    expect((await post([item()])).status).toBe(200)
    expect(prisma.search.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['old1', 'old2'] } } })
  })

  it('skips deleteMany when nothing is past the cap', async () => {
    expect((await post([item()])).status).toBe(200)
    expect(prisma.search.deleteMany).not.toHaveBeenCalled()
  })

  it('counts what survived the prune, not what existed before it', async () => {
    mock(prisma.search.findMany).mockResolvedValue([{ id: 'old1' }])
    expect((await post([item()])).status).toBe(200)
    expect(prisma.search.count).toHaveBeenCalledWith({ where: { userId: 'user1' } })
    expect(mock(prisma.search.count).mock.invocationCallOrder[0]).toBeGreaterThan(
      mock(prisma.search.deleteMany).mock.invocationCallOrder[0]
    )
  })

})

describe('import response', () => {
  it('reports everything saved when nothing collides', async () => {
    mock(prisma.search.count).mockResolvedValue(3)
    const body = await (await post([item(), item(), item()])).json()
    expect(body).toMatchObject({ saved: 3, duplicates: 0, dropped: 0 })
  })

  it('reports the rows the prune evicted rather than the rows inserted', async () => {
    // a history full of favorites: the batch lands, then the prune takes it back
    mock(prisma.search.count).mockResolvedValueOnce(25).mockResolvedValueOnce(0)
    const body = await (await post([item(), item(), item()])).json()
    expect(body).toMatchObject({ saved: 0, duplicates: 0, dropped: 3 })
    expect(body.limit).toMatchObject({ cap: 25, used: 25, atCap: true })
  })

  it('counts only the survivors when the prune takes some of the batch', async () => {
    mock(prisma.search.count).mockResolvedValueOnce(25).mockResolvedValueOnce(2)
    const body = await (await post([item(), item(), item()])).json()
    expect(body).toMatchObject({ saved: 2, duplicates: 0, dropped: 1 })
  })

  it('counts the createMany shortfall as duplicates', async () => {
    mock(prisma.search.createMany).mockResolvedValue({ count: 1 })
    mock(prisma.search.count).mockResolvedValue(1)
    const some = await (await post([item(), item(), item()])).json()
    expect(some).toMatchObject({ saved: 1, duplicates: 2 })
    mock(prisma.search.createMany).mockResolvedValue({ count: 0 })
    mock(prisma.search.count).mockResolvedValue(0)
    const none = await (await post([item({ handId: 'h1' }), item({ handId: 'h2' })])).json()
    expect(none).toMatchObject({ saved: 0, duplicates: 2 })
  })

  it('returns the free limit block', async () => {
    mock(prisma.search.count).mockResolvedValue(3)
    const body = await (await post([item()])).json()
    expect(body.limit).toEqual({ plan: 'free', cap: 25, used: 3, atCap: false })
  })

  it('prunes at and reports the pro cap for a pro user', async () => {
    mock(getPlan).mockResolvedValue(PRO)
    mock(prisma.search.count).mockResolvedValue(120)
    const body = await (await post([item()])).json()
    expect(getPlan).toHaveBeenCalledWith('user1')
    expect(mock(prisma.search.findMany).mock.calls[0][0].skip).toBe(5000)
    expect(body.limit).toEqual({ plan: 'pro', cap: 5000, used: 120, atCap: false })
  })

  it('flags atCap once the count reaches the cap', async () => {
    mock(prisma.search.count).mockResolvedValue(25)
    expect((await (await post([item()])).json()).limit.atCap).toBe(true)
    mock(prisma.search.count).mockResolvedValue(24)
    expect((await (await post([item()])).json()).limit.atCap).toBe(false)
  })

  it('500 when createMany fails', async () => {
    mock(prisma.search.createMany).mockRejectedValue(new Error('db down'))
    const res = await post([item()])
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })
})
