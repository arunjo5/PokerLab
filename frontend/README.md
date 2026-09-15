# PokerLab — Frontend

Texas Hold'em analytics: Monte Carlo equity, range analysis, pot odds/MDF, a heads-up river CFR solver (GTO or exploit mode against imported opponent tendencies), and a hand replayer.

## Stack

- Vite + React 18 (JavaScript)
- The poker engine runs in-browser (Monte Carlo in a Web Worker). Accounts, saved hands, and billing talk to the backend over `/api`.

## Run locally

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173.

## Build for production

```bash
npm run build      # outputs to dist/
npm run preview    # serves the production build locally
```

`npm run lint` (ESLint) and `npm run test` (Vitest) cover linting and tests.

## Project structure

```
frontend/
├── index.html              entry HTML, loads /src/main.jsx
├── vite.config.js
└── src/
    ├── main.jsx            ReactDOM.createRoot
    ├── App.jsx             top-level layout, state, modals
    ├── styles.css          all styles (dark + light via .light class)
    ├── pokerEngine.js      deck, 7-card evaluator, Monte Carlo equity
    ├── equityWorker.js     runs the simulation off the main thread
    ├── replayerEngine.js   betting/positions/frame logic
    ├── Replayer.jsx        hand replayer + step-through playback
    ├── solverEngine.js     heads-up river CFR+ solver, node locking + best response for exploit mode
    ├── solverWorker.js     runs the solve off the main thread
    ├── SolverView.jsx      solver setup -> solving -> results flow
    ├── SolverSetup.jsx     board/range/bet-size configuration + villain model
    ├── SolverResults.jsx   strategy grid + exploitability / exploit readouts
    ├── solverBits.jsx      shared solver UI (range thumbnail, legend)
    ├── solver.css          solver styles
    ├── pokernowImport.js   parse PokerNow JSON exports into replayable hands
    ├── pokernowCsv.js      parse the PokerNow .csv text log into the same raw hands
    ├── scenario.js         scenario <-> URL state
    ├── shareCodec.js       compact share-link encoding (lz-string)
    ├── replayShare.js      share encoding for replays
    ├── shareLinks.js       Pro short links (/s/<code>) client + URL helpers
    ├── api.js              fetch wrapper for /api
    ├── library.js          saved ranges + saved solves client
    ├── LibraryContext.jsx  account library state (ranges, solves, caps)
    ├── SolverSaved.jsx     saved-solves panel + save control
    ├── sessionStats.js     hero stats + opponent river tendencies from imported replays
    ├── statsHands.js       loads every imported hand for stats and opponent profiles
    ├── StatsView.jsx       Session stats page (Pro)
    ├── Info.jsx            gold (i) tooltip
    ├── Menu.jsx            themed dropdown
    ├── hooks.js            useFlash (self-clearing toast state)
    ├── Cards.jsx           card chips and glyphs
    ├── Pickers.jsx         CardPicker (52-card grid) + RangePicker (13x13)
    ├── Seat.jsx            PlayerSeat + range thumbnail
    ├── HistoryDrawer.jsx   saved-hand history panel
    ├── PlansView.jsx       Free vs Pro plans page
    ├── UpgradePrompt.jsx   shown once when a free account fills its history
    ├── ShareModal.jsx      share-link modal
    ├── UploadModal.jsx     PokerNow log import
    └── AuthContext.jsx     session, plan, and billing state from the backend
```
