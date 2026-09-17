# PokerLab — Setup Guide

## Prerequisites

- Node.js 18.17+ (Next 14's minimum)
- A PostgreSQL database (e.g. Neon)
- A Google Cloud project — only if you want Google sign-in
- An Upstash Redis database — only if you want real rate limiting
- A Stripe account — only if you want the paid Pro plan

## 1. Install

```bash
npm install
```

## 2. Environment variables

Create `.env`:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/pokerlab"

# Auth.js (NextAuth v5)
AUTH_SECRET="your-secret"          # openssl rand -base64 32
AUTH_URL="http://localhost:3000"   # your domain in production

# Google sign-in (optional — omit both to run username/password only)
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"

# Rate limiting (optional — see section 6)
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""

# Pro plan via Stripe (optional — see section 7)
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRICE_MONTHLY="price_..."
STRIPE_PRICE_YEARLY="price_..."
APP_URL="http://localhost:5173"    # the frontend origin Stripe returns users to
```

Notes:
- Username/password sign-in works with no Google config.
- Locally `AUTH_URL` can be omitted (the app trusts the host); set it to your real domain in production.

## 3. Google OAuth (optional)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type **Web application**.
3. Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` (dev)
   - `https://yourdomain.com/api/auth/callback/google` (prod)
4. Copy the Client ID and Secret into `.env`.

## 4. Database

```bash
npx prisma db push        # apply the schema (prisma generate runs on install)
```

## 5. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## 6. Rate limiting (optional)

Every mutating route is rate-limited. With the two `UPSTASH_*` vars unset the limiter
falls back to an in-memory counter, which is fine locally but only limits a single
instance — set both in production.

1. Create a Redis database at [Upstash](https://console.upstash.com/).
2. Copy the REST URL and REST token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

Two things to know about the free tier:

- **Idle databases are deleted.** A database with no traffic for a couple of weeks is
  removed, and every rate-limited route then pays a timeout on each request until the
  limiter's circuit breaker trips. The daily `/api/health` cron in `vercel.json` exists
  to keep both Upstash and Neon warm.
- **The limiter degrades rather than fails.** If Upstash is unreachable it times out
  quickly, logs a warning, and falls back to the in-memory limiter, so requests still
  succeed.

## 7. Stripe billing (optional)

The Pro plan is hidden in the UI until `STRIPE_SECRET_KEY` and both price ids are set. The
webhook secret is separate: without it subscriptions never sync back onto users.

1. In the [Stripe Dashboard](https://dashboard.stripe.com/) (test mode) create a product **PokerLab Pro** with two recurring prices: monthly and yearly. Copy each price id into `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY`.
2. **Developers → API keys**: copy the secret key into `STRIPE_SECRET_KEY`.
3. **Settings → Billing → Customer portal**: enable cancelling and switching between the two prices, then save.
4. Locally, forward webhooks with the Stripe CLI and copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`:

   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

5. Set `APP_URL` to the frontend origin (`http://localhost:5173` in dev).

Test cards: `4242 4242 4242 4242`, any future expiry, any CVC.

## Troubleshooting

- **Invalid redirect URI**: the Google redirect URI must match exactly.
- **Database connection error**: check `DATABASE_URL` and that the database exists.
- **Prisma client not initialized**: run `npx prisma generate`.
- **A schema change isn't live**: run `npx prisma db push` against the target database.
- **New env vars seem ignored on Vercel**: they only apply to builds after they were
  saved, so redeploy after adding them.
- **Every signed-in request is slow (seconds, not milliseconds)**: the Upstash database
  is unreachable or was deleted. Check `/api/health`, then recreate it and update the
  two `UPSTASH_*` vars.

## Deploying on Vercel

The two halves deploy as separate Vercel projects from the same repository:

- **Backend** — root directory `backend`. `vercel.json` sets the security headers and the
  daily `/api/health` cron. Hobby plans allow one cron a day, which is what the schedule uses.
- **Frontend** — root directory `frontend`. `vercel.json` rewrites `/api/:path*` to the
  backend deployment so the browser only ever talks to one origin, and rewrites `/s/:code`
  to `index.html` so short links resolve in the SPA instead of 404ing.

Point `AUTH_URL` at the backend domain and `APP_URL` at the frontend domain. Env var
changes need a redeploy to take effect.

## Production

- Use a managed PostgreSQL (Neon) with production env values.
- Set `AUTH_URL` to your production domain and use a strong, unique `AUTH_SECRET`.
- Add the production domain to the Google OAuth redirect URIs.
- Stripe: switch to live keys and prices, set `APP_URL` to the production frontend origin, and register a webhook endpoint at `https://<backend-domain>/api/webhooks/stripe` (events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`) with its signing secret in `STRIPE_WEBHOOK_SECRET`.

## Security

- Never commit `.env`.
- Use strong secrets in production and rotate OAuth credentials periodically.
- API routes are rate-limited (Upstash Redis, with an in-memory fallback).
