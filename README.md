## PokerLab

#### Texas Hold'Em analytics platform with hand/range equity, hand-history replay, and a CFR solver.

<p>
  <img src="pokerlab-calculator.png" width="49%" alt="PokerLab equity calculator" />
  <img src="pokerlab-solver.png" width="49%" alt="PokerLab heads-up river solver" />
</p>

PokerLab lets you deal hole cards, assign ranges, and set the board, then computes each player’s equity using a Monte Carlo simulation. It also includes a side panel for calculating pot odds and MDF in the current spot. A heads-up river solver finds the GTO strategy for a single river decision between two ranges using CFR. Pro accounts can also lock the villain to river tendencies observed in their imported hands (bet, fold, and raise rates, shrunk toward GTO on small samples) and solve their best response, with the gain over GTO play and the cost if the villain adapts. You can import PokerNow logs into the replayer, share exact board states or replays, and review past hands from your profile page.

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
|      Share links · PokerNow import · saved history       |
|      Web Workers · Monte Carlo + CFR (client-side)       |
+----------------------------------------------------------+
                             |
                /api/*  ·  same-origin proxy
                             |
+----------------------------------------------------------+
|                 Backend  ·  Next.js API                  |
|                                                          |
|         NextAuth v5 · Credentials + Google · JWT         |
|      /api/searches · saved-hand CRUD · rate-limited      |
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

See [`frontend/README.md`](./frontend/README.md) and [`backend/README.md`](./backend/README.md) for details, and [`backend/setup.md`](./backend/setup.md) for the auth/DB setup walkthrough.
