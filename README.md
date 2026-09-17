## PokerLab

#### Texas Hold'Em analytics platform with hand/range equity, hand-history replay, and a CFR solver.

<p>
  <img src="pokerlab-calculator.png" width="49%" alt="PokerLab equity calculator" />
  <img src="pokerlab-solver.png" width="49%" alt="PokerLab heads-up river solver" />
</p>

PokerLab lets you choose each player’s hole cards or range and set the board. It then uses a Monte Carlo simulation to calculate each player’s equity. A side panel helps you work out pot odds and MDF for the current spot, while a heads-up river solver uses CFR to find a GTO strategy for a single river decision between two ranges.

With Pro, you can find the best response to an opponent’s river tendencies based on how often they bet, fold, and raise in your imported hands. With fewer hands, the estimates stay closer to GTO. The solver shows how much you gain over GTO play and what you risk giving up if your opponent adjusts.

You can also import hand histories from PokerNow (.json or .csv), PokerStars, and GGPoker into the replayer, share exact board states or replays, and revisit past hands from your profile page.

## Architecture

```text
+----------------------------------------------------------+
|                     Users / Browsers                     |
|                                                          |
|                       pokerlab.dev                       |
+----------------------------------------------------------+
                             |
                           HTTPS
                             |
+----------------------------------------------------------+
|              Frontend  ·  Vite + React SPA               |
|                                                          |
|     Equity Calculator · Hand Replayer · River Solver     |
|    GTO + exploit solves · session stats · share links    |
|       Hand-history import · saved history · plans        |
|      Web Workers · Monte Carlo + CFR (client-side)       |
+----------------------------------------------------------+
                             |
                /api/*  ·  same-origin proxy
                             |
+----------------------------------------------------------+
|                 Backend  ·  Next.js API                  |
|                                                          |
|         NextAuth v5 · Credentials + Google · JWT         |
|     /api/searches · hands, bulk import, dedupe by id     |
|   /api/share · /api/ranges · /api/solves · /api/stats    |
|     /api/billing · Stripe Checkout · webhook-synced      |
+----------------------------------------------------------+
                             |
                             |
+----------------------------------------------------------+
|                     Data & Services                      |
|                                                          |
|  Neon Postgres (Prisma) · Upstash Redis · Google OAuth   |
+----------------------------------------------------------+
```

## Quick start guide

```bash
# Frontend (Vite + React)
cd frontend
npm install
npm run dev          # http://localhost:5173

# Backend (Next.js, NextAuth, Prisma)
cd backend
npm install
npm run dev          # http://localhost:3000
```

The frontend proxies `/api` to the backend on port 3000, so run both to sign in or save hands.

## Tests

```bash
cd frontend && npm test     # 1,163 tests — engines, solver, import parsers, UI flows
cd backend  && npm test     # 663 tests — routes, auth gates, plan limits, billing
```

See [`frontend/README.md`](./frontend/README.md) and [`backend/README.md`](./backend/README.md) for details, and [`backend/setup.md`](./backend/setup.md) for the auth, database, rate-limiting, and deployment walkthrough.

## License

MIT
