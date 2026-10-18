# PulseTrade

A realtime fintech dashboard built with Angular. A **WebAssembly** market-data producer, written in
**AssemblyScript**, runs inside a **Web Worker**. The app has two pages:

- **Dashboard** (`/dashboard`): a live table with one row per instrument showing last traded price,
  bid–ask spread, cumulative volume, cumulative VWAP and order-book imbalance. It also has a
  Pause/Resume control and producer status (state, run number, nominal and measured rate, totals,
  and batch generation time).
- **Settings** (`/settings`): a validated form for instrument count (1–50), updates per batch
  (1–1,000) and batch interval (50–2,000 ms). The form doesn't affect the producer until you click
  **Apply**. Apply starts a new run with cleared state, even if the previous run was paused.

## Getting started

```bash
npm install
npm start          # builds the Wasm module, then runs ng serve on http://localhost:4200
npm test           # builds Wasm, then runs Angular unit tests + Wasm tests
npm run build      # builds Wasm + production bundle into dist/
```

`npm run build:wasm` compiles `wasm/assembly/index.ts` to `public/wasm/market-producer.wasm`. This
file is generated and git-ignored. The `prestart`, `prebuild` and `pretest` scripts run it
automatically.

## Architecture

```
┌──────────── UI thread ────────────┐        ┌──────────────── Web Worker ────────────────┐
│ Dashboard / Settings (OnPush)     │        │ ProducerEngine                             │
│        ▲ signals                  │ start  │  • setTimeout cadence (no catch-up)        │
│ ProducerService (root singleton)  │ pause  │  • per run: new Wasm instance + aggregator │
│  • owns the single Worker         │ resume │  • posts ≤ 1 snapshot / 100 ms             │
│  • runId guard drops stale data   │ ─────▶ │        │                                   │
│                                   │ ◀───── │        ▼ zero-copy Int32Array view         │
│                                   │snapshot│ Wasm (AssemblyScript): PRNG + price model  │
└───────────────────────────────────┘        └────────────────────────────────────────────┘
```

### Wasm library (`wasm/assembly/index.ts`)

- The module has **no host imports**. All randomness and price evolution happen in Wasm:
  - SplitMix64 seeds the generator and xorshift64\* produces the random stream.
  - Box–Muller generates Gaussian noise.
- Instrument state is kept between calls: the mid price as a geometric random walk, plus bid and
  ask quantities as bounded random walks.
- Each update follows these rules:
  - The spread is at least 1¢, so `bid < ask`.
  - The trade price is either the bid or the ask. Buyers lift the ask more often when the book is
    bid-heavy.
  - Trade quantities are positive and heavy-tailed.
  - Book quantities are never negative.
  - Prices stay within $1–$100,000.
- `generate(n)` writes `n` records of seven `i32` values into a static buffer:
  `[instrument, priceCents, tradeQty, bidCents, askCents, bidQty, askQty]`. The worker reads them
  directly through an `Int32Array` view over linear memory. No JSON or per-update objects are
  created.
- The same seed always produces the same output, which makes the module testable.

### Metrics (`src/app/producer/market-aggregator.ts`)

- Metrics are calculated in the worker. Each instrument keeps O(1) state, and the event history is
  not stored.
- Every generated trade is counted exactly once, even when the UI is refreshed less often.
- Notional (Σ price × qty, in cents) is summed per batch as an exact `Float64`, then added to a
  `BigInt` total. This keeps VWAP exact on long, high-rate runs.
- Prices remain integer cents until they're displayed. VWAP may be fractional and is rounded only
  for display.
- A value shows as `—` when there's no data yet or its denominator is zero.

### Lifecycle and correctness

- `ProducerService` is a root singleton, so navigating between pages keeps the current run and its
  running/paused state, and never creates another worker.
- Each Apply increments `runId`. The worker tags every message with its run ID, and the service
  ignores messages from older runs.
- Every run gets a **new Wasm instance** compiled from the cached module. The previous instance and
  its timer are released.
- Retry replaces the worker. When the app is destroyed, the worker is told to dispose and is then
  terminated.
- Pausing clears the worker timer and sends any data that hasn't been shown yet. Resuming schedules
  the next batch one interval later, so nothing is generated for the paused time.
- Initialisation errors are shown in the UI with a Retry button. These include a missing or invalid
  `.wasm` file, missing exports, worker script errors, and WebAssembly being unsupported.

### Performance

At the maximum settings (50 instruments, 1,000 updates every 50 ms = 20,000 updates/s), a batch takes
about 0.2 ms in the worker. The UI receives at most 10 small snapshots per second.

## Tests

- `src/**/*.spec.ts` (Angular + Vitest):
  - aggregator calculations, including the worked example from the specification
  - formatting
  - `ProducerEngine` scheduling, throttling, pause/resume, run replacement, errors and disposal,
    using a manual clock
  - `ProducerService` with a fake worker
  - Dashboard and Settings components
  - navigation, checking that it preserves the run
- `wasm/test/*.test.ts` (Vitest in Node): runs the real compiled module and checks:
  - it has no imports and returns the requested batch sizes
  - invariants hold over 500k updates
  - prices continue from previous values and state is kept between calls
  - output is deterministic for a seed
  - instances are isolated
  - loading errors are reported
