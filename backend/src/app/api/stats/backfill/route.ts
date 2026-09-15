import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readJsonBody } from '@/lib/body'
import { userGate } from '@/lib/gate'
import { requirePro, validStats } from '@/lib/stats'

const MAX_ITEMS = 100

// store client-computed stats on older imported hands; owner-scoped, replay rows only
export async function POST(request: NextRequest) {
  try {
    const who = await userGate(request, 'save')
    if (who.error) return who.error
    const gate = await requirePro(who.userId)
    if (gate) return gate

    const parsed = await readJsonBody(request, 192 * 1024)
    if (parsed.error) return parsed.error
    const items = parsed.data?.items
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return NextResponse.json({ error: 'Invalid items' }, { status: 400 })
    }
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(it.id) || !validStats(it.stats)) {
        return NextResponse.json({ error: 'Invalid items' }, { status: 400 })
      }
    }

    const counts = await prisma.$transaction(
      items.map((it: { id: string; stats: object }) =>
        prisma.$executeRaw`UPDATE "Search" SET replay = jsonb_set(replay, '{stats}', ${JSON.stringify(it.stats)}::jsonb, true)
          WHERE id = ${it.id} AND "userId" = ${who.userId} AND "isReplay" = true AND replay IS NOT NULL`
      )
    )
    return NextResponse.json({ updated: counts.reduce((a, b) => a + b, 0) })
  } catch (error) {
    console.error('Error backfilling stats:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
