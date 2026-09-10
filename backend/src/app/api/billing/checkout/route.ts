import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { readJsonBody } from '@/lib/body'
import { limit } from '@/lib/rateLimit'
import { effectivePlan } from '@/lib/plan'
import { stripe, priceId, billingEnabled, appUrl } from '@/lib/stripe'

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const userId = session.user.id

    const rl = await limit('billing', userId)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
      )
    }
    if (!billingEnabled()) {
      return NextResponse.json({ error: 'Billing is not configured' }, { status: 503 })
    }

    const parsed = await readJsonBody(request, 1024)
    if (parsed.error) return parsed.error
    const interval = parsed.data?.interval === 'month' ? 'month' : 'year'

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, plan: true, planExpiresAt: true, stripeCustomerId: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (effectivePlan(user) === 'pro') {
      return NextResponse.json({ error: 'Already on Pro' }, { status: 409 })
    }

    // first purchase: let checkout create the customer (one fewer stripe round trip);
    // the webhook stores its id. the email column holds a username for password accounts.
    const email = user.email && user.email.includes('@') ? user.email : undefined
    const who = user.stripeCustomerId ? { customer: user.stripeCustomerId } : { customer_email: email }

    const base = appUrl(request)
    const checkout = await stripe().checkout.sessions.create({
      mode: 'subscription',
      ...who,
      line_items: [{ price: priceId(interval)!, quantity: 1 }],
      success_url: `${base}/?billing=success`,
      cancel_url: `${base}/?billing=cancel`,
      client_reference_id: userId,
      metadata: { userId },
      subscription_data: { metadata: { userId } },
      allow_promotion_codes: true,
    })
    if (!checkout.url) {
      return NextResponse.json({ error: 'Could not start checkout' }, { status: 500 })
    }
    return NextResponse.json({ url: checkout.url })
  } catch (error) {
    console.error('Error creating checkout session:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
