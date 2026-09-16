import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readJsonBody, cleanName } from '@/lib/body'
import { userGate } from '@/lib/gate'
import { getPlan } from '@/lib/plan'

// Bulk hand-history import. One request per batch instead of one per hand, and
// (userId, handId) is unique, so re-importing a log inserts nothing new.
const MAX_BODY = 1024 * 1024
const MAX_ITEMS = 25
const MAX_NAME = 200
const MAX_HAND_ID = 100

type Item = {
  handId?: unknown
  name?: unknown
  players?: unknown
  board?: unknown
  odds?: unknown
  playerNames?: unknown
  isReplay?: unknown
  replay?: unknown
  favorite?: unknown
}

function invalid(it: Item): string | null {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return 'Invalid item'
  const { handId, name, players, board, odds, playerNames, replay } = it
  if (handId != null && (typeof handId !== 'string' || !handId || handId.length > MAX_HAND_ID)) return 'Invalid handId'
  if (!Array.isArray(players) || players.length > 9) return 'Invalid players'
  if (!Array.isArray(board) || board.length > 5) return 'Invalid board'
  if (typeof odds !== 'object' || odds === null || Array.isArray(odds)) return 'Invalid odds'
  if (name != null && (typeof name !== 'string' || name.length > MAX_NAME)) return 'Invalid name'
  if (
    playerNames != null &&
    (!Array.isArray(playerNames) ||
      playerNames.length > 9 ||
      playerNames.some((n: unknown) => n != null && (typeof n !== 'string' || n.length > 100)))
  ) {
    return 'Invalid playerNames'
  }
  if (
    JSON.stringify(players).length > 16384 ||
    JSON.stringify(board).length > 2048 ||
    JSON.stringify(odds).length > 16384 ||
    (replay != null && JSON.stringify(replay).length > 49152)
  ) {
    return 'Field too large'
  }
  return null
}

export async function POST(request: NextRequest) {
  try {
    const who = await userGate(request, 'save')
    if (who.error) return who.error

    const parsed = await readJsonBody(request, MAX_BODY)
    if (parsed.error) return parsed.error
    const items = parsed.data?.items
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return NextResponse.json({ error: 'Invalid items' }, { status: 400 })
    }
    for (const it of items) {
      const bad = invalid(it)
      if (bad) return NextResponse.json({ error: bad }, { status: 400 })
    }

    const { plan, saveCap } = await getPlan(who.userId)
    // spread the timestamps so history keeps the order the hands were played in
    const base = Date.now() - items.length
    const rows = items.map((it: Item, i: number) => ({
      userId: who.userId,
      handId: typeof it.handId === 'string' && it.handId ? it.handId : null,
      name: typeof it.name === 'string' ? cleanName(it.name) : null,
      players: it.players as never,
      board: it.board as never,
      odds: it.odds as never,
      playerNames: (it.playerNames ?? null) as never,
      isReplay: !!it.isReplay,
      replay: (it.replay ?? null) as never,
      favorite: !!it.favorite,
      createdAt: new Date(base + i),
      lastAccessedAt: new Date(base + i),
    }))

    const { count } = await prisma.search.createMany({ data: rows, skipDuplicates: true })

    // prune past the cap (LRU): favorites first, then most-recently-used
    const stale = await prisma.search.findMany({
      where: { userId: who.userId },
      orderBy: [{ favorite: 'desc' }, { lastAccessedAt: 'desc' }, { createdAt: 'desc' }],
      skip: saveCap,
      select: { id: true },
    })
    if (stale.length) {
      await prisma.search.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
    }
    const used = await prisma.search.count({ where: { userId: who.userId } })
    // the prune can evict what we just wrote (a history full of favorites, say),
    // so report what survived rather than what was inserted
    const kept = await prisma.search.count({
      where: { userId: who.userId, createdAt: { gte: new Date(base) } },
    })

    return NextResponse.json({
      saved: kept,
      duplicates: items.length - count,
      dropped: count - kept,
      limit: { plan, cap: saveCap, used, atCap: used >= saveCap },
    })
  } catch (error) {
    console.error('Error importing hands:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
