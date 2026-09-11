import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: vi.fn() } } }))
vi.mock('@/lib/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan')>()),
  getPlan: vi.fn(),
}))

import { requirePro, validStats } from '@/lib/stats'
import { getPlan, PLAN_LIMITS } from '@/lib/plan'

const asMock = (f: unknown) => f as ReturnType<typeof vi.fn>

const FREE = { plan: 'free', interval: null, expiresAt: null, saveCap: 25, limits: PLAN_LIMITS.free, hasCustomer: false }
const PRO = { plan: 'pro', interval: 'year', expiresAt: null, saveCap: 5000, limits: PLAN_LIMITS.pro, hasCustomer: true }

const NUM = ['hero', 'players', 'bb', 'agg', 'calls', 'net', 'pot', 'v'] as const
const BOOL = ['cents', 'vpip', 'pfr', 'tbOpp', 'tb', 'flop', 'sd', 'wsd'] as const

// one whole valid record; the tests bend a single field at a time
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

const bend = (k: string, v: unknown) => ({ ...STATS, [k]: v })
const without = (k: string) => {
  const o: Record<string, unknown> = { ...STATS }
  delete o[k]
  return o
}
// a valid record padded out to exactly n serialised characters
const sized = (n: number) => ({ ...STATS, f: 'x'.repeat(n - JSON.stringify({ ...STATS, f: '' }).length) })

beforeEach(() => {
  vi.clearAllMocks()
  asMock(getPlan).mockResolvedValue(PRO)
})

describe('requirePro', () => {
  it('lets a pro user through with no response', async () => {
    expect(await requirePro('user1')).toBeNull()
  })

  it('reads the plan once, for the user it was given', async () => {
    await requirePro('user7')
    expect(getPlan).toHaveBeenCalledTimes(1)
    expect(getPlan).toHaveBeenCalledWith('user7')
  })

  it('403 pro_required for a free user', async () => {
    asMock(getPlan).mockResolvedValue(FREE)
    const res = await requirePro('user1')
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: 'Session stats are a Pro feature', code: 'pro_required' })
  })

  it('403 for anything that is not exactly pro', async () => {
    for (const plan of ['free', 'Pro', 'PRO', 'trial', '', null, undefined]) {
      asMock(getPlan).mockResolvedValue({ ...FREE, plan })
      expect((await requirePro('user1'))?.status).toBe(403)
    }
  })
})

describe('validStats shape', () => {
  it('accepts a whole record', () => {
    expect(validStats(STATS)).toBe(true)
  })

  it('rejects anything that is not an object', () => {
    for (const s of [null, undefined, 0, 1, NaN, '', 'x', true, false, () => {}]) {
      expect(validStats(s)).toBe(false)
    }
  })

  it('rejects arrays, even one carrying the right fields', () => {
    expect(validStats([])).toBe(false)
    expect(validStats([STATS])).toBe(false)
    expect(validStats(Object.assign([], STATS))).toBe(false)
  })

  it('rejects an empty object', () => {
    expect(validStats({})).toBe(false)
  })

  it('ignores extra keys', () => {
    expect(validStats({ ...STATS, extra: 'ok', nested: { a: 1 } })).toBe(true)
  })
})

describe('validStats numbers', () => {
  it('needs every numeric field present', () => {
    for (const k of NUM) expect(validStats(without(k))).toBe(false)
  })

  it('rejects a numeric field of the wrong type', () => {
    for (const k of NUM) {
      for (const v of [undefined, null, '1', '', true, false, {}, []]) expect(validStats(bend(k, v))).toBe(false)
    }
  })

  it('rejects NaN and both infinities', () => {
    for (const k of NUM) {
      for (const v of [NaN, Infinity, -Infinity]) expect(validStats(bend(k, v))).toBe(false)
    }
  })

  it('accepts zero, negatives and fractions', () => {
    for (const k of NUM) {
      for (const v of [0, -0, -12.5, 0.25, 1e6]) expect(validStats(bend(k, v))).toBe(true)
    }
  })
})

describe('validStats booleans', () => {
  it('needs every boolean field present', () => {
    for (const k of BOOL) expect(validStats(without(k))).toBe(false)
  })

  it('rejects truthy stand-ins for a boolean', () => {
    for (const k of BOOL) {
      for (const v of [undefined, null, 0, 1, '', 'true', 'false', {}, []]) expect(validStats(bend(k, v))).toBe(false)
    }
  })

  it('accepts both true and false', () => {
    for (const k of BOOL) {
      expect(validStats(bend(k, true))).toBe(true)
      expect(validStats(bend(k, false))).toBe(true)
    }
  })
})

describe('validStats pos', () => {
  it('is optional', () => {
    expect(validStats(without('pos'))).toBe(true)
    expect(validStats(bend('pos', undefined))).toBe(true)
    expect(validStats(bend('pos', null))).toBe(true)
  })

  it('takes a string up to eight characters', () => {
    expect(validStats(bend('pos', ''))).toBe(true)
    expect(validStats(bend('pos', 'BTN'))).toBe(true)
    expect(validStats(bend('pos', 'x'.repeat(8)))).toBe(true)
  })

  it('rejects a ninth character', () => {
    expect(validStats(bend('pos', 'x'.repeat(9)))).toBe(false)
  })

  it('rejects a non-string pos', () => {
    for (const v of [0, 42, true, false, {}, ['BTN']]) expect(validStats(bend('pos', v))).toBe(false)
  })
})

describe('validStats size', () => {
  it('accepts a record right on the 600 character cap', () => {
    const o = sized(600)
    expect(JSON.stringify(o).length).toBe(600)
    expect(validStats(o)).toBe(true)
  })

  it('rejects one character past it', () => {
    const o = sized(601)
    expect(JSON.stringify(o).length).toBe(601)
    expect(validStats(o)).toBe(false)
  })

  it('measures the whole record, so a fat nested value trips it', () => {
    expect(validStats({ ...STATS, notes: { text: 'x'.repeat(600) } })).toBe(false)
  })

  it('sizes before it types, so an oversize record fails with every field right', () => {
    expect(validStats(sized(900))).toBe(false)
  })
})
