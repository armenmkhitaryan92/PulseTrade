import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MarketAggregator,
  RECORD_SIZE,
  RecordField,
} from '../../src/app/producer/market-aggregator';
import {
  compileProducerModule,
  validateExports,
  WasmMarketGenerator,
} from '../../src/app/producer/wasm-market-generator';

const wasmPath = fileURLToPath(new URL('../../public/wasm/market-producer.wasm', import.meta.url));

interface Update {
  instrument: number;
  price: number;
  quantity: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

function decode(records: Int32Array): Update[] {
  const updates: Update[] = [];
  for (let o = 0; o < records.length; o += RECORD_SIZE) {
    updates.push({
      instrument: records[o + RecordField.Instrument],
      price: records[o + RecordField.PriceCents],
      quantity: records[o + RecordField.TradeQuantity],
      bid: records[o + RecordField.BidCents],
      ask: records[o + RecordField.AskCents],
      bidQty: records[o + RecordField.BidQuantity],
      askQty: records[o + RecordField.AskQuantity],
    });
  }
  return updates;
}

describe('Wasm market producer', () => {
  let module: WebAssembly.Module;
  const create = (instruments: number, seed: number) => {
    const generator = WasmMarketGenerator.fromModule(module);
    generator.init(instruments, seed);
    return generator;
  };

  beforeAll(async () => {
    module = await WebAssembly.compile(readFileSync(wasmPath));
  });

  it('has no host imports, so all randomness and pricing runs in Wasm', () => {
    expect(WebAssembly.Module.imports(module)).toEqual([]);
  });

  it('exposes the expected limits', () => {
    const generator = WasmMarketGenerator.fromModule(module);
    expect(generator.maxBatchSize).toBe(1000);
    expect(generator.maxInstruments).toBe(50);
  });

  it('produces nothing before initialisation', () => {
    expect(WasmMarketGenerator.fromModule(module).generate(10)).toHaveLength(0);
  });

  it('returns batches of exactly the requested size', () => {
    const generator = create(5, 1);
    for (const size of [1, 7, 100, 1000]) {
      expect(generator.generate(size)).toHaveLength(size * RECORD_SIZE);
    }
  });

  it('clamps batch size to the supported maximum', () => {
    expect(create(5, 1).generate(5000)).toHaveLength(1000 * RECORD_SIZE);
  });

  it('keeps every update valid across a long run', () => {
    const generator = create(50, 7);
    const seen = new Set<number>();
    const invalid: Update[] = [];
    for (let batch = 0; batch < 500; batch++) {
      for (const u of decode(generator.generate(1000))) {
        seen.add(u.instrument);
        const valid =
          u.instrument >= 0 &&
          u.instrument < 50 &&
          u.bid > 0 &&
          u.bid < u.ask &&
          (u.price === u.bid || u.price === u.ask) &&
          u.quantity > 0 &&
          u.bidQty >= 0 &&
          u.askQty >= 0;
        if (!valid) invalid.push(u);
      }
    }
    expect(invalid).toEqual([]);
    expect(seen.size).toBe(50);
  });

  it('only generates updates for the configured instruments', () => {
    const updates = decode(create(3, 9).generate(1000));
    expect(new Set(updates.map((u) => u.instrument))).toEqual(new Set([0, 1, 2]));
  });

  it('evolves prices from previous values and retains state between calls', () => {
    const generator = create(1, 123);
    const mids: number[] = [];
    for (let i = 0; i < 200; i++) {
      const [u] = decode(generator.generate(1));
      mids.push((u.bid + u.ask) / 2);
    }
    for (let i = 1; i < mids.length; i++) {
      expect(Math.abs(mids[i] - mids[i - 1]) / mids[i - 1]).toBeLessThan(0.01);
    }
    expect(new Set(mids).size).toBeGreaterThan(10);
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const a = Array.from(create(5, 42).generate(100));
    const b = Array.from(create(5, 42).generate(100));
    const c = Array.from(create(5, 43).generate(100));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('resets state on re-initialisation', () => {
    const generator = create(5, 42);
    const first = Array.from(generator.generate(50));
    generator.generate(500);
    generator.init(5, 42);
    expect(Array.from(generator.generate(50))).toEqual(first);
  });

  it('isolates state between instances', () => {
    const a = create(5, 1);
    const b = create(5, 1);
    const fromA = Array.from(a.generate(20));
    a.generate(1000);
    expect(Array.from(b.generate(20))).toEqual(fromA);
  });

  it('feeds the aggregator end-to-end', () => {
    const generator = create(2, 5);
    const aggregator = new MarketAggregator(2);
    let volume = 0;
    for (let i = 0; i < 10; i++) {
      const records = generator.generate(100);
      decode(records).forEach((u) => (volume += u.quantity));
      aggregator.ingest(records, records.length / RECORD_SIZE);
    }
    const rows = aggregator.snapshot();
    expect(rows[0].volume + rows[1].volume).toBe(volume);
    for (const row of rows) {
      expect(row.vwapCents).toBeGreaterThan(0);
      expect(row.spreadCents).toBeGreaterThan(0);
      expect(row.imbalance).toBeGreaterThanOrEqual(-1);
      expect(row.imbalance).toBeLessThanOrEqual(1);
    }
  });
});

describe('Wasm loading', () => {
  it('reports HTTP failures with a helpful message', async () => {
    const fetchFn = async () => new Response(null, { status: 404 });
    await expect(compileProducerModule('/missing.wasm', fetchFn)).rejects.toThrow(
      /HTTP 404.*build:wasm/,
    );
  });

  it('reports network failures', async () => {
    const fetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(compileProducerModule('/x.wasm', fetchFn)).rejects.toThrow(
      'Could not download the Wasm producer from /x.wasm: Failed to fetch',
    );
  });

  it('reports invalid modules', async () => {
    const fetchFn = async () => new Response(new Uint8Array([1, 2, 3, 4]));
    await expect(compileProducerModule('/bad.wasm', fetchFn)).rejects.toThrow(/is invalid/);
  });

  it('compiles a valid module', async () => {
    const fetchFn = async () => new Response(readFileSync(wasmPath));
    const module = await compileProducerModule('/ok.wasm', fetchFn);
    expect(() => WasmMarketGenerator.fromModule(module)).not.toThrow();
  });

  it('rejects modules with missing exports', () => {
    expect(() => validateExports({ memory: new WebAssembly.Memory({ initial: 1 }) })).toThrow(
      /missing exports: init, generate/,
    );
    expect(() => validateExports({})).toThrow(/memory/);
  });
});
