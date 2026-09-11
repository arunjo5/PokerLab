// FE-contract fixtures: payloads below replicate exactly what frontend/src/App.jsx
// builds (saveReplayToHistory, onImportConfirm, doSave, commitToHistory) so backend
// validation can't drift away from real frontend traffic.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/auth', () => ({ auth: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: { search: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(async () => 0) } },
}))
vi.mock('@/lib/plan', () => ({
  getPlan: vi.fn(async () => ({ plan: 'free', saveCap: 25, interval: null, expiresAt: null, hasCustomer: false })),
}))
vi.mock('@/lib/rateLimit', () => ({ limit: vi.fn(async () => ({ ok: true, retryAfter: 0 })) }))

import { POST } from '@/app/api/searches/route'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

function req(body: unknown): Request {
  const json = JSON.stringify(body)
  const h: Record<string, string> = { 'content-length': String(Buffer.byteLength(json, 'utf8')) }
  return {
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
    text: async () => json,
  } as unknown as Request
}

const card = (v: string, s: string) => ({ v, s })

// hand.replay as produced by pokernowImport.js / the hand builder
const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO']
function replayHand(seatCount = 2, actionCount = 4) {
  const holes = [
    [card('A', 's'), card('K', 'd')],
    [card('7', 'c'), card('2', 'd')],
  ]
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    name: `p${i}`,
    stack: 10000,
    pos: seatCount === 2 ? ['BTN', 'BB'][i] : POSITIONS[i],
    cards: i < 2 ? holes[i] : null,
  }))
  const actions = Array.from({ length: actionCount }, (_, i) => ({
    seat: i % 2,
    type: 'call',
    amount: 100,
    street: 0,
  }))
  return {
    setup: { sb: 50, bb: 100, ante: 0, cents: true, seats },
    actions,
    board: [card('J', 'h'), card('T', 'd'), card('2', 's')],
    board2: null,
    won: { 1: 200 },
    runResults: null,
  }
}

// App.jsx: seats.map(s => s.cards && s.cards.length === 2 ? {kind:'hand', hand:s.cards} : null)
const playersForRow = (hand: ReturnType<typeof replayHand>) =>
  hand.setup.seats.map((s) => (s.cards && s.cards.length === 2 ? { kind: 'hand', hand: s.cards } : null))

// App.jsx saveReplayToHistory body (~line 261)
const saveReplayBody = (hand: ReturnType<typeof replayHand>, blindsLabel: string) => ({
  name: `Replay · ${blindsLabel}`,
  players: playersForRow(hand),
  board: hand.board || [],
  odds: {},
  isReplay: true,
  replay: hand,
  favorite: true,
})

// App.jsx onImportConfirm body (~line 302)
const importBody = (h: { number: number; replay: ReturnType<typeof replayHand> }) => ({
  name: `Hand #${h.number}`,
  players: playersForRow(h.replay),
  board: h.replay.board || [],
  odds: {},
  isReplay: true,
  replay: h.replay,
  favorite: false,
})

// App.jsx doSave / commitToHistory scenario state
const scenarioState = () => ({
  players: [
    { kind: 'hand', hand: [card('A', 's'), card('A', 'h')] },
    { kind: 'range', range: ['AA', 'KK', 'AKs'] },
    null, null, null, null, null, null, null,
  ],
  board: [card('Q', 'd'), card('J', 'c'), card('9', 's')],
  playerNames: ['Hero', 'Villain', null, null, null, null, null, null, null],
  scenario: '~CoCwpgdgJg9gziAXAbVBANgQwC5oKwA0YA7gJYBOgA',
  odds: {
    0: { win: 61.2, tie: 0.4, equity: 61.4 },
    1: { win: 38.4, tie: 0.4, equity: 38.6 },
  },
})

// App.jsx doSave body (~line 514)
const doSaveBody = (name: string | null) => ({
  name: name || null,
  ...scenarioState(),
  favorite: true,
})

// App.jsx commitToHistory auto-save body (~line 563): no favorite/isReplay keys
const autoSaveBody = () => ({ name: null, ...scenarioState() })

const createData = (i = 0) =>
  (prisma.search.create as ReturnType<typeof vi.fn>).mock.calls[i][0].data

beforeEach(() => {
  vi.clearAllMocks()
  ;(auth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user1' } })
  ;(prisma.search.create as ReturnType<typeof vi.fn>).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 's1', ...data })
  )
  ;(prisma.search.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

describe('FE contract: saveReplayToHistory payload', () => {
  it('accepts a favorited 9-seat replay and returns the {search:{id}} shape App.jsx reads', async () => {
    const hand = replayHand(9)
    const res = await POST(req(saveReplayBody(hand, '1/2')) as never)
    expect(res.status).toBe(200)
    const data = createData()
    expect(data.name).toBe('Replay · 1/2')
    expect(data.isReplay).toBe(true)
    expect(data.favorite).toBe(true)
    expect(data.replay).toEqual(hand)
    expect(data.userId).toBe('user1')
    // App.jsx: data && data.search ? data.search.id : null
    expect((await res.json()).search.id).toBe('s1')
  })

  it('keeps the players row (hand seats + null padding) within the 9-player cap', async () => {
    const res = await POST(req(saveReplayBody(replayHand(9), '0.5/1')) as never)
    expect(res.status).toBe(200)
    expect(createData().players).toHaveLength(9)
    expect(createData().players[0]).toEqual({ kind: 'hand', hand: [card('A', 's'), card('K', 'd')] })
    expect(createData().players[2]).toBeNull()
  })
})

describe('FE contract: onImportConfirm payload', () => {
  it('accepts an imported PokerNow replay saved unfavorited', async () => {
    const hand = replayHand(2)
    const res = await POST(req(importBody({ number: 12, replay: hand })) as never)
    expect(res.status).toBe(200)
    const data = createData()
    expect(data.name).toBe('Hand #12')
    expect(data.isReplay).toBe(true)
    expect(data.favorite).toBe(false)
    expect(data.replay).toEqual(hand)
  })

  it('400 "Field too large" for a replay whose JSON exceeds the 49152-char field cap', async () => {
    const hand = replayHand(2, 1300) // ~63KB of actions: over the field cap, under MAX_BODY
    expect(JSON.stringify(hand).length).toBeGreaterThan(49152)
    const body = importBody({ number: 99, replay: hand })
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(100 * 1024)
    const res = await POST(req(body) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Field too large')
    expect(prisma.search.create).not.toHaveBeenCalled()
  })

  it('413 "Payload too large" when the whole import body crosses the 100KB readJsonBody cap', async () => {
    const hand = replayHand(2, 2400) // ~118KB body
    const body = importBody({ number: 100, replay: hand })
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeGreaterThan(100 * 1024)
    const res = await POST(req(body) as never)
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('Payload too large')
    expect(prisma.search.create).not.toHaveBeenCalled()
  })
})

describe('FE contract: doSave and auto-save scenario payloads', () => {
  it('accepts the manual doSave payload (named, favorited, with scenario string)', async () => {
    const res = await POST(req(doSaveBody('My spot')) as never)
    expect(res.status).toBe(200)
    const data = createData()
    expect(data.name).toBe('My spot')
    expect(data.favorite).toBe(true)
    expect(data.isReplay).toBe(false)
    expect(data.replay).toBeNull()
    expect(data.scenario).toBe(scenarioState().scenario)
    expect(data.playerNames).toEqual(scenarioState().playerNames)
    expect(data.players).toEqual(scenarioState().players)
    expect(data.odds).toEqual(scenarioState().odds)
  })

  it('accepts doSave with an empty modal name coerced to null', async () => {
    const res = await POST(req(doSaveBody(null)) as never)
    expect(res.status).toBe(200)
    expect(createData().name).toBeNull()
  })

  it('accepts the commitToHistory auto-save payload, defaulting favorite/isReplay off', async () => {
    const res = await POST(req(autoSaveBody()) as never)
    expect(res.status).toBe(200)
    const data = createData()
    expect(data.name).toBeNull()
    expect(data.favorite).toBe(false)
    expect(data.isReplay).toBe(false)
    expect(data.replay).toBeNull()
  })
})
