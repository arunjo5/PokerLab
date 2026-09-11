import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: vi.fn(), $executeRaw: vi.fn() } }))
vi.mock('@/lib/rateLimit', () => ({ limit: vi.fn(async () => ({ ok: true, retryAfter: 0 })) }))
vi.mock('@/lib/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan')>()),
  getPlan: vi.fn(),
}))

import { POST } from '@/app/api/stats/backfill/route'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/rateLimit'
import { getPlan, PLAN_LIMITS } from '@/lib/plan'

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>
const transaction = asMock(prisma.$transaction)
const executeRaw = asMock(prisma.$executeRaw)

const FREE = { plan: 'free', interval: null, expiresAt: null, saveCap: 25, limits: PLAN_LIMITS.free, hasCustomer: false }
const PRO = { plan: 'pro', interval: 'year', expiresAt: null, saveCap: 5000, limits: PLAN_LIMITS.pro, hasCustomer: true }

const STATS = {
  hero: 2,
  players: 6,
  bb: 100,
  agg: 3,
  calls: 1,
  net: -450,
  pot: 1200,
  v: 1,
  cents: true,
  vpip: true,
  pfr: false,
  tbOpp: true,
  tb: false,
  flop: true,
  sd: false,
  wsd: false,
  pos: 'BTN',
}

const item = (id: string, stats: unknown = STATS) => ({ id, stats })
const many = (n: number) => Array.from({ length: n }, (_, i) => item(`h${i + 1}`))

function req(body: unknown = {}, headers: Record<string, string> = {}): Request {
  const json = JSON.stringify(body)
  const h: Record<string, string> = { 'content-length': String(Buffer.byteLength(json, 'utf8')), ...headers }
  return {
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
    text: async () => json,
  } as unknown as Request
}

// $executeRaw is a template tag; the mock keeps the strings and values it was handed
const stmt = (i = 0) => executeRaw.mock.calls[i]
const values = (i = 0) => stmt(i).slice(1)
const sql = (i = 0) => (stmt(i)[0] as string[]).join('?').replace(/\s+/g, ' ')

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  asMock(auth).mockResolvedValue({ user: { id: 'user1' } })
  asMock(limit).mockResolvedValue({ ok: true, retryAfter: 0 })
  asMock(getPlan).mockResolvedValue(PRO)
  let n = 0
  executeRaw.mockImplementation(() => ({ statement: n++ }))
  transaction.mockImplementation(async (stmts: unknown[]) => stmts.map(() => 1))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stats backfill gates', () => {
  it('403 on a cross-site request, before any auth work', async () => {
    const res = await POST(req({ items: [item('h1')] }, { 'sec-fetch-site': 'cross-site' }) as never)
    expect(res.status).toBe(403)
    expect(auth).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('401 when unauthenticated', async () => {
    asMock(auth).mockResolvedValue(null)
    expect((await POST(req({ items: [item('h1')] }) as never)).status).toBe(401)
    expect(limit).not.toHaveBeenCalled()
    expect(getPlan).not.toHaveBeenCalled()
  })

  it('429 with Retry-After on the save bucket', async () => {
    asMock(limit).mockResolvedValue({ ok: false, retryAfter: 45 })
    const res = await POST(req({ items: [item('h1')] }) as never)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('45')
    expect(limit).toHaveBeenCalledWith('save', 'user1')
    expect(getPlan).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('403 pro_required for a free user, writing nothing', async () => {
    asMock(getPlan).mockResolvedValue(FREE)
    const res = await POST(req({ items: [item('h1')] }) as never)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Session stats are a Pro feature', code: 'pro_required' })
    expect(getPlan).toHaveBeenCalledWith('user1')
    expect(executeRaw).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('checks the plan before it reads the body', async () => {
    asMock(getPlan).mockResolvedValue(FREE)
    expect((await POST(req({ items: [] }) as never)).status).toBe(403)
    expect((await POST(req({}) as never)).status).toBe(403)
  })

  it('413 past the 96KB body cap', async () => {
    expect((await POST(req({ items: [item('h1')] }, { 'content-length': '98305' }) as never)).status).toBe(413)
    expect((await POST(req({ items: [item('h1')], pad: 'x'.repeat(98304) }) as never)).status).toBe(413)
    expect(transaction).not.toHaveBeenCalled()
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
})

describe('stats backfill items', () => {
  const bad = async (body: unknown) => {
    const res = await POST(req(body) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid items')
  }

  it('400 when items is missing, wrong-typed or empty', async () => {
    for (const items of [undefined, null, 0, 42, '', 'h1', true, {}, []]) await bad({ items })
    await bad({})
    await bad(null)
  })

  it('400 past a hundred items', async () => {
    await bad({ items: many(101) })
  })

  it('accepts exactly a hundred', async () => {
    const res = await POST(req({ items: many(100) }) as never)
    expect(res.status).toBe(200)
    expect(executeRaw).toHaveBeenCalledTimes(100)
  })

  it('400 when an entry is not an object', async () => {
    for (const entry of [null, undefined, 0, 'h1', true, []]) await bad({ items: [entry] })
  })

  it('400 on an id that is missing, wrong-typed, empty, oversize or off-charset', async () => {
    const ids = [undefined, null, 0, 42, true, {}, [], '', 'x'.repeat(41), 'has-dash', 'has_score', 'has space', 'héllo', 'a.b', 'a/b']
    for (const id of ids) await bad({ items: [{ id, stats: STATS }] })
  })

  it('takes an alphanumeric id from one to forty characters', async () => {
    for (const id of ['a', '0', 'aB9', 'x'.repeat(40)]) {
      expect((await POST(req({ items: [item(id)] }) as never)).status).toBe(200)
    }
  })

  it('400 on stats that fail validStats', async () => {
    const oversize = { ...STATS, f: 'x'.repeat(600) }
    const stats = [
      undefined,
      null,
      42,
      'x',
      true,
      {},
      [],
      [STATS],
      { ...STATS, hero: NaN },
      { ...STATS, pot: Infinity },
      { ...STATS, net: '-450' },
      { ...STATS, cents: 1 },
      { ...STATS, wsd: undefined },
      { ...STATS, pos: 'x'.repeat(9) },
      { ...STATS, pos: 42 },
      oversize,
    ]
    for (const s of stats) await bad({ items: [{ id: 'h1', stats: s }] })
  })

  it('rejects the whole batch when a single entry is bad, touching nothing', async () => {
    await bad({ items: [item('h1'), item('h2'), item('h3', {})] })
    expect(executeRaw).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('stats backfill write', () => {
  it('runs one statement per item, in a single transaction', async () => {
    const res = await POST(req({ items: many(3) }) as never)
    expect(res.status).toBe(200)
    expect(executeRaw).toHaveBeenCalledTimes(3)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction.mock.calls[0][0]).toHaveLength(3)
  })

  it('writes the stats into the replay column, scoped to the row and its owner', async () => {
    await POST(req({ items: [item('h1')] }) as never)
    expect(sql()).toContain('UPDATE "Search" SET replay = jsonb_set(replay, \'{stats}\', ?::jsonb, true)')
    expect(sql()).toContain('WHERE id = ? AND "userId" = ? AND "isReplay" = true AND replay IS NOT NULL')
  })

  it('binds the serialised stats, the item id and the user id', async () => {
    await POST(req({ items: [item('h1')] }) as never)
    expect(values()).toEqual([JSON.stringify(STATS), 'h1', 'user1'])
  })

  it("carries each item's own id and stats", async () => {
    const second = item('h2', { ...STATS, net: 900, pos: 'CO' })
    await POST(req({ items: [item('h1'), second] }) as never)
    expect(values(0)).toEqual([JSON.stringify(STATS), 'h1', 'user1'])
    expect(values(1)).toEqual([JSON.stringify(second.stats), 'h2', 'user1'])
  })

  it('keys the update on the session user, not on anything in the body', async () => {
    asMock(auth).mockResolvedValue({ user: { id: 'other' } })
    await POST(req({ items: [{ ...item('h1'), userId: 'user1' }], userId: 'user1' }) as never)
    expect(values()).toEqual([JSON.stringify(STATS), 'h1', 'other'])
  })

  it('sums the per-statement row counts', async () => {
    transaction.mockResolvedValue([2, 0, 3])
    const res = await POST(req({ items: many(3) }) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 5 })
  })

  it('reports zero when nothing matched', async () => {
    transaction.mockResolvedValue([0, 0])
    expect(await (await POST(req({ items: many(2) }) as never)).json()).toEqual({ updated: 0 })
  })

  it('counts one row per item on a clean run', async () => {
    expect(await (await POST(req({ items: many(4) }) as never)).json()).toEqual({ updated: 4 })
  })
})

describe('stats backfill failures', () => {
  it('500 when the transaction throws', async () => {
    transaction.mockRejectedValue(new Error('db down'))
    const res = await POST(req({ items: [item('h1')] }) as never)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error' })
  })

  it('500 when a statement cannot be built, without opening a transaction', async () => {
    executeRaw.mockImplementation(() => {
      throw new Error('bad sql')
    })
    expect((await POST(req({ items: [item('h1')] }) as never)).status).toBe(500)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('500 when the plan lookup throws, without writing', async () => {
    asMock(getPlan).mockRejectedValue(new Error('db down'))
    expect((await POST(req({ items: [item('h1')] }) as never)).status).toBe(500)
    expect(executeRaw).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
})
