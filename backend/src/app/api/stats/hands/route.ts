import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/rateLimit'
import { requirePro } from '@/lib/stats'

const PAGE = 100

// imported hands for the stats page: stored stats when present, the full replay when
// an older row still needs analysing (the client writes the result back via backfill)
export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = session.user.id
    const rl = await limit('read', userId)
    if (!rl.ok) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } })
    }
    const gate = await requirePro(userId)
    if (gate) return gate

    const cursor = request?.url ? new URL(request.url).searchParams.get('cursor') : null
    const rows = await prisma.search.findMany({
      where: { userId, isReplay: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, createdAt: true, replay: true },
    })
    const page = rows.slice(0, PAGE)
    const hands = page.map((r) => {
      const rep = r.replay && typeof r.replay === 'object' && !Array.isArray(r.replay) ? (r.replay as Record<string, unknown>) : null
      const stats = rep && rep.stats && typeof rep.stats === 'object' ? rep.stats : null
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        session: rep && rep.session && typeof rep.session === 'object' ? rep.session : null,
        stats,
        replay: stats ? undefined : rep,
      }
    })
    return NextResponse.json({ hands, nextCursor: rows.length > PAGE ? page[page.length - 1].id : null })
  } catch (error) {
    console.error('Error listing stats hands:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
