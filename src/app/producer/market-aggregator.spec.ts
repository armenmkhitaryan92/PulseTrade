import { emptyMetrics, MarketAggregator } from './market-aggregator';
import { encodeUpdates, TestUpdate } from './testing';

const quote = { bidCents: 10196, askCents: 10200, bidQuantity: 600, askQuantity: 400 };

describe('MarketAggregator', () => {
  it('reports unavailable values and zero volume before any data', () => {
    const [row] = new MarketAggregator(1).snapshot();
    expect(row).toEqual({
      index: 0,
      symbol: 'ALFA',
      lastPriceCents: null,
      spreadCents: null,
      volume: 0,
      vwapCents: null,
      imbalance: null,
      tradeCount: 0,
    });
  });

  it('matches the worked example from the specification', () => {
    const aggregator = new MarketAggregator(2);
    const updates: TestUpdate[] = [
      { instrument: 0, priceCents: 10000, tradeQuantity: 10, ...quote },
      { instrument: 0, priceCents: 10200, tradeQuantity: 30, ...quote },
    ];
    aggregator.ingest(encodeUpdates(updates), updates.length);

    const [alfa, beta] = aggregator.snapshot();
    expect(alfa.lastPriceCents).toBe(10200);
    expect(alfa.volume).toBe(40);
    expect(alfa.vwapCents).toBe(10150);
    expect(alfa.spreadCents).toBe(4);
    expect(alfa.imbalance).toBeCloseTo(0.2, 12);
    expect(beta.volume).toBe(0);
    expect(beta.lastPriceCents).toBeNull();
  });

  it('accumulates volume and VWAP across batches and uses the latest quote', () => {
    const aggregator = new MarketAggregator(1);
    aggregator.ingest(
      encodeUpdates([{ instrument: 0, priceCents: 10000, tradeQuantity: 10, ...quote }]),
      1,
    );
    aggregator.ingest(
      encodeUpdates([
        {
          instrument: 0,
          priceCents: 10200,
          tradeQuantity: 30,
          bidCents: 10150,
          askCents: 10210,
          bidQuantity: 100,
          askQuantity: 300,
        },
      ]),
      1,
    );
    const [row] = aggregator.snapshot();
    expect(row.volume).toBe(40);
    expect(row.vwapCents).toBe(10150);
    expect(row.spreadCents).toBe(60);
    expect(row.imbalance).toBe(-0.5);
    expect(row.tradeCount).toBe(2);
  });

  it('only ingests the first `count` records of the buffer', () => {
    const aggregator = new MarketAggregator(1);
    const records = encodeUpdates([
      { instrument: 0, priceCents: 100, tradeQuantity: 1, ...quote },
      { instrument: 0, priceCents: 999, tradeQuantity: 999, ...quote },
    ]);
    aggregator.ingest(records, 1);
    expect(aggregator.snapshot()[0].volume).toBe(1);
  });

  it('reports an unavailable imbalance when both book quantities are zero', () => {
    const aggregator = new MarketAggregator(1);
    aggregator.ingest(
      encodeUpdates([
        {
          instrument: 0,
          priceCents: 100,
          tradeQuantity: 1,
          ...quote,
          bidQuantity: 0,
          askQuantity: 0,
        },
      ]),
      1,
    );
    expect(aggregator.snapshot()[0].imbalance).toBeNull();
  });

  it('accumulates notional beyond 2^53 cent-units without drift', () => {
    const aggregator = new MarketAggregator(1);
    const update = { instrument: 0, priceCents: 9_999_999, tradeQuantity: 1000, ...quote };
    const batch = encodeUpdates(Array.from({ length: 1000 }, () => update));
    // 1,000 batches × 1,000 trades × ~1e10 = ~1e16 cent-units (> 2^53 ≈ 9e15).
    for (let i = 0; i < 1000; i++) aggregator.ingest(batch, 1000);
    const [row] = aggregator.snapshot();
    expect(row.volume).toBe(1e9);
    expect(row.vwapCents).toBe(9_999_999);
  });

  it('rejects updates for unknown instruments', () => {
    const aggregator = new MarketAggregator(1);
    const records = encodeUpdates([{ instrument: 3, priceCents: 1, tradeQuantity: 1, ...quote }]);
    expect(() => aggregator.ingest(records, 1)).toThrow(RangeError);
  });

  it('creates placeholder rows for every instrument', () => {
    const rows = emptyMetrics(3);
    expect(rows.map((r) => r.symbol)).toEqual(['ALFA', 'BETA', 'GAMA']);
    expect(rows.every((r) => r.volume === 0 && r.vwapCents === null)).toBe(true);
  });
});
