import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { getPlan } from '@/lib/plan'

// session stats are pro-only
export async function requirePro(userId: string) {
  const { plan } = await getPlan(userId)
  if (plan === 'pro') return null
  return NextResponse.json({ error: 'Session stats are a Pro feature', code: 'pro_required' }, { status: 403 })
}

// rows whose stats predate this get their replay sent back for re-analysis
export const STATS_VERSION = 2

const NUM = ['hero', 'players', 'bb', 'agg', 'calls', 'net', 'pot', 'v'] as const
const BOOL = ['cents', 'vpip', 'pfr', 'tbOpp', 'tb', 'flop', 'sd', 'wsd'] as const
const OPP_LEN = 7
const MAX_OPP = 12

// opp: { name: [hands, bet opps, bets, faced, folds, calls, raises] }, one row per other seat
function validOpp(o: unknown): boolean {
  if (o == null) return true
  if (typeof o !== 'object' || Array.isArray(o)) return false
  const entries = Object.entries(o as Record<string, unknown>)
  if (entries.length > MAX_OPP) return false
  for (const [name, row] of entries) {
    if (!name || name.length > 40) return false
    if (!Array.isArray(row) || row.length !== OPP_LEN) return false
    for (const v of row) if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000) return false
  }
  return true
}

// the per-hand record the client computes; small, flat, typed
export function validStats(s: unknown): boolean {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false
  const o = s as Record<string, unknown>
  if (JSON.stringify(o).length > 1500) return false
  for (const k of NUM) if (typeof o[k] !== 'number' || !Number.isFinite(o[k] as number)) return false
  if (!Number.isInteger(o.v) || (o.v as number) < 1 || (o.v as number) > STATS_VERSION) return false
  for (const k of BOOL) if (typeof o[k] !== 'boolean') return false
  if (o.pos != null && (typeof o.pos !== 'string' || (o.pos as string).length > 8)) return false
  if (!validOpp(o.opp)) return false
  return true
}

export type ReplayJson = Prisma.JsonObject
