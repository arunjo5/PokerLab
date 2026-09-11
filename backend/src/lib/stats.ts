import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { getPlan } from '@/lib/plan'

// session stats are pro-only
export async function requirePro(userId: string) {
  const { plan } = await getPlan(userId)
  if (plan === 'pro') return null
  return NextResponse.json({ error: 'Session stats are a Pro feature', code: 'pro_required' }, { status: 403 })
}

const NUM = ['hero', 'players', 'bb', 'agg', 'calls', 'net', 'pot', 'v'] as const
const BOOL = ['cents', 'vpip', 'pfr', 'tbOpp', 'tb', 'flop', 'sd', 'wsd'] as const

// the per-hand record the client computes; small, flat, typed
export function validStats(s: unknown): boolean {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false
  const o = s as Record<string, unknown>
  if (JSON.stringify(o).length > 600) return false
  for (const k of NUM) if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) return false
  for (const k of BOOL) if (typeof o[k] !== 'boolean') return false
  if (o.pos != null && (typeof o.pos !== 'string' || (o.pos as string).length > 8)) return false
  return true
}

export type ReplayJson = Prisma.JsonObject
