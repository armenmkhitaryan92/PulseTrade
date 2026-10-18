// Market-update producer compiled to WebAssembly with AssemblyScript.
//
// The module owns all randomness and price evolution. Each call to `generate`
// writes `count` fixed-size i32 records into a static output buffer that the
// host reads directly from linear memory (no per-update allocation or copying).
//
// Record layout (RECORD_SIZE i32 values per update):
//   0 instrument index   1 trade price (cents)   2 trade quantity
//   3 bid (cents)        4 ask (cents)           5 bid quantity   6 ask quantity

const MAX_INSTRUMENTS: i32 = 50;
const MAX_BATCH_SIZE: i32 = 1000;
const RECORD_SIZE: i32 = 7;

const MIN_MID_CENTS: f64 = 100.0; // $1.00
const MAX_MID_CENTS: f64 = 10_000_000.0; // $100,000.00
const MAX_BOOK_QUANTITY: i32 = 5000;
const MAX_TRADE_QUANTITY: i32 = 1000;
const VOLATILITY_PER_UPDATE: f64 = 0.0006;

// Per-instrument state retained between `generate` calls.
const midCents = new StaticArray<f64>(MAX_INSTRUMENTS);
const bidQuantity = new StaticArray<i32>(MAX_INSTRUMENTS);
const askQuantity = new StaticArray<i32>(MAX_INSTRUMENTS);

const output = new StaticArray<i32>(MAX_BATCH_SIZE * RECORD_SIZE);

let instruments: i32 = 0;
let rngState: u64 = 0;

// ---------------------------------------------------------------------------
// Random number generation (SplitMix64 for seeding, xorshift64* for the stream)
// ---------------------------------------------------------------------------

function splitMix64(x: u64): u64 {
  let z = x + 0x9e3779b97f4a7c15;
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9;
  z = (z ^ (z >> 27)) * 0x94d049bb133111eb;
  return z ^ (z >> 31);
}

function nextU64(): u64 {
  let x = rngState;
  x ^= x >> 12;
  x ^= x << 25;
  x ^= x >> 27;
  rngState = x;
  return x * 0x2545f4914f6cdd1d;
}

/** Uniform float in [0, 1). */
function nextUnit(): f64 {
  return <f64>(nextU64() >> 11) * (1.0 / 9007199254740992.0);
}

/** Uniform integer in [min, max]. */
function nextInt(min: i32, max: i32): i32 {
  return min + <i32>(nextUnit() * <f64>(max - min + 1));
}

/** Standard normal sample (Box–Muller). */
function nextGaussian(): f64 {
  let u = nextUnit();
  if (u < 1e-12) u = 1e-12;
  const v = nextUnit();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clampF(value: f64, min: f64, max: f64): f64 {
  return value < min ? min : value > max ? max : value;
}

function clampI(value: i32, min: i32, max: i32): i32 {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resets the generator for a new run. `count` is clamped to [1, MAX_INSTRUMENTS].
 * The same seed always produces the same sequence of updates.
 */
export function init(count: i32, seed: u32): void {
  instruments = clampI(count, 1, MAX_INSTRUMENTS);
  rngState = splitMix64(<u64>seed);
  if (rngState == 0) rngState = 0x9e3779b97f4a7c15;

  for (let i = 0; i < MAX_INSTRUMENTS; i++) {
    // Starting prices between $20 and $500, whole cents.
    unchecked((midCents[i] = <f64>nextInt(2_000, 50_000)));
    unchecked((bidQuantity[i] = nextInt(100, 1000)));
    unchecked((askQuantity[i] = nextInt(100, 1000)));
  }
}

/**
 * Generates `count` market updates (clamped to [0, MAX_BATCH_SIZE]) into the
 * output buffer and returns the number of records written. Returns 0 if the
 * generator has not been initialised.
 */
export function generate(count: i32): i32 {
  if (instruments == 0) return 0;
  const n = clampI(count, 0, MAX_BATCH_SIZE);

  for (let k = 0; k < n; k++) {
    const i = nextInt(0, instruments - 1);

    // Book quantities follow a bounded random walk (nonnegative).
    let bidQty = clampI(unchecked(bidQuantity[i]) + nextInt(-60, 60), 0, MAX_BOOK_QUANTITY);
    let askQty = clampI(unchecked(askQuantity[i]) + nextInt(-60, 60), 0, MAX_BOOK_QUANTITY);
    unchecked((bidQuantity[i] = bidQty));
    unchecked((askQuantity[i] = askQty));

    const depth = bidQty + askQty;
    const imbalance: f64 = depth > 0 ? <f64>(bidQty - askQty) / <f64>depth : 0.0;

    // Mid price: geometric random walk with a small drift towards book pressure.
    let mid = unchecked(midCents[i]);
    mid *= Math.exp(VOLATILITY_PER_UPDATE * (nextGaussian() + 0.15 * imbalance));
    mid = clampF(mid, MIN_MID_CENTS, MAX_MID_CENTS);

    // Spread of roughly 1–5 basis points, at least one cent.
    const maxSpread = clampI(<i32>(mid * 0.0005), 1, 10_000);
    const spread = nextInt(1, maxSpread);
    let bid = <i32>Math.round(mid - <f64>spread / 2.0);
    if (bid < 1) bid = 1;
    const ask = bid + spread;

    // Buyers lift the ask more often when the bid side is heavier.
    const buyerInitiated = nextUnit() < 0.5 + 0.25 * imbalance;
    const price = buyerInitiated ? ask : bid;

    // Heavy-tailed trade size: mostly small, occasionally large.
    const quantity = clampI(1 + <i32>(-Math.log(1.0 - nextUnit()) * 25.0), 1, MAX_TRADE_QUANTITY);

    // The trade nudges the mid towards the traded price.
    unchecked((midCents[i] = clampF(mid * 0.9 + <f64>price * 0.1, MIN_MID_CENTS, MAX_MID_CENTS)));

    const o = k * RECORD_SIZE;
    unchecked((output[o] = i));
    unchecked((output[o + 1] = price));
    unchecked((output[o + 2] = quantity));
    unchecked((output[o + 3] = bid));
    unchecked((output[o + 4] = ask));
    unchecked((output[o + 5] = bidQty));
    unchecked((output[o + 6] = askQty));
  }
  return n;
}

/** Byte offset of the output buffer in linear memory. */
export function outputPointer(): usize {
  return changetype<usize>(output);
}

export function recordSize(): i32 {
  return RECORD_SIZE;
}

export function maxBatchSize(): i32 {
  return MAX_BATCH_SIZE;
}

export function maxInstruments(): i32 {
  return MAX_INSTRUMENTS;
}

export function instrumentCount(): i32 {
  return instruments;
}
