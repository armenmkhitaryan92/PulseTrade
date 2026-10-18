import { instrumentSymbol } from './instrument-symbols';
import { InstrumentMetrics } from './producer.models';

/** Field offsets inside one update record produced by the Wasm library. */
export const RecordField = {
  Instrument: 0,
  PriceCents: 1,
  TradeQuantity: 2,
  BidCents: 3,
  AskCents: 4,
  BidQuantity: 5,
  AskQuantity: 6,
} as const;

export const RECORD_SIZE = 7;

/**
 * Folds market updates into cumulative per-instrument state without keeping
 * the event history. Every trade contributes exactly once to volume and VWAP.
 *
 * Notional (Σ price×quantity, in cents) is accumulated exactly: each batch is
 * summed in a Float64Array (a batch stays far below 2^53) and then added to a
 * BigInt total, so long runs never lose integer precision.
 */
export class MarketAggregator {
  private readonly lastPrice: Int32Array;
  private readonly bid: Int32Array;
  private readonly ask: Int32Array;
  private readonly bidQty: Int32Array;
  private readonly askQty: Int32Array;
  private readonly volume: Float64Array;
  private readonly trades: Float64Array;
  private readonly batchNotional: Float64Array;
  private readonly touched: Uint8Array;
  private readonly notional: bigint[];

  constructor(readonly instrumentCount: number) {
    this.lastPrice = new Int32Array(instrumentCount);
    this.bid = new Int32Array(instrumentCount);
    this.ask = new Int32Array(instrumentCount);
    this.bidQty = new Int32Array(instrumentCount);
    this.askQty = new Int32Array(instrumentCount);
    this.volume = new Float64Array(instrumentCount);
    this.trades = new Float64Array(instrumentCount);
    this.batchNotional = new Float64Array(instrumentCount);
    this.touched = new Uint8Array(instrumentCount);
    this.notional = new Array<bigint>(instrumentCount).fill(0n);
  }

  /** Ingests `count` records laid out as described by {@link RecordField}. */
  ingest(records: Int32Array, count: number): void {
    for (let k = 0; k < count; k++) {
      const o = k * RECORD_SIZE;
      const i = records[o + RecordField.Instrument];
      if (i < 0 || i >= this.instrumentCount) {
        throw new RangeError(`Update references unknown instrument index ${i}`);
      }
      const price = records[o + RecordField.PriceCents];
      const qty = records[o + RecordField.TradeQuantity];

      this.lastPrice[i] = price;
      this.bid[i] = records[o + RecordField.BidCents];
      this.ask[i] = records[o + RecordField.AskCents];
      this.bidQty[i] = records[o + RecordField.BidQuantity];
      this.askQty[i] = records[o + RecordField.AskQuantity];
      this.volume[i] += qty;
      this.trades[i] += 1;
      this.batchNotional[i] += price * qty;
      this.touched[i] = 1;
    }

    for (let i = 0; i < this.instrumentCount; i++) {
      if (this.touched[i]) {
        this.notional[i] += BigInt(this.batchNotional[i]);
        this.batchNotional[i] = 0;
        this.touched[i] = 0;
      }
    }
  }

  snapshot(): InstrumentMetrics[] {
    const result: InstrumentMetrics[] = new Array(this.instrumentCount);
    for (let i = 0; i < this.instrumentCount; i++) {
      const hasData = this.trades[i] > 0;
      const volume = this.volume[i];
      const depth = this.bidQty[i] + this.askQty[i];
      result[i] = {
        index: i,
        symbol: instrumentSymbol(i),
        lastPriceCents: hasData ? this.lastPrice[i] : null,
        spreadCents: hasData ? this.ask[i] - this.bid[i] : null,
        volume,
        vwapCents: volume > 0 ? Number(this.notional[i]) / volume : null,
        imbalance: hasData && depth > 0 ? (this.bidQty[i] - this.askQty[i]) / depth : null,
        tradeCount: this.trades[i],
      };
    }
    return result;
  }
}

/** Placeholder rows shown before any data for a run has arrived. */
export function emptyMetrics(instrumentCount: number): InstrumentMetrics[] {
  return new MarketAggregator(instrumentCount).snapshot();
}
