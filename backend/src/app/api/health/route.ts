import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { limit } from '@/lib/rateLimit'

// liveness check, also hit by a daily cron so neon and upstash never go idle
// long enough to be suspended or deleted. no auth: a SELECT 1 and one redis command.
export async function GET() {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, limit('read', 'health')])
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('health check failed:', error)
    return NextResponse.json({ ok: false }, { status: 503 })
  }
}
