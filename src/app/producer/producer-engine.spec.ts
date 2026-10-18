import { GeneratorFactory, ProducerEngine } from './producer-engine';
import { ProducerEvent, ProducerSettings } from './producer.models';
import { encodeUpdates } from './testing';
import { MarketGenerator } from './wasm-market-generator';

class ManualClock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };

  clearTimer = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = end;
  }
}

class FakeGenerator implements MarketGenerator {
  readonly maxBatchSize = 1000;
  readonly maxInstruments = 50;
  instrumentCount = 0;
  generated = 0;

  init(instrumentCount: number): void {
    this.instrumentCount = instrumentCount;
  }

  generate(count: number): Int32Array {
    this.generated += count;
    return encodeUpdates(
      Array.from({ length: count }, (_, k) => ({
        instrument: k % this.instrumentCount,
        priceCents: 100,
        tradeQuantity: 1,
        bidCents: 99,
        askCents: 100,
        bidQuantity: 10,
        askQuantity: 10,
      })),
    );
  }
}

const settings: ProducerSettings = {
  instrumentCount: 2,
  updatesPerBatch: 10,
  batchIntervalMs: 100,
};

describe('ProducerEngine', () => {
  let clock: ManualClock;
  let events: ProducerEvent[];
  let generators: FakeGenerator[];
  let engine: ProducerEngine;
  let loadGenerator: (url: string) => Promise<GeneratorFactory>;

  const snapshots = () =>
    events.filter((e): e is Extract<ProducerEvent, { type: 'snapshot' }> => e.type === 'snapshot');
  const lastSnapshot = () => snapshots().at(-1)!;

  function createEngine(): ProducerEngine {
    return new ProducerEngine({
      post: (event) => events.push(event),
      loadGenerator: (url) => loadGenerator(url),
      now: () => clock.time,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      randomSeed: () => 42,
      snapshotIntervalMs: 100,
    });
  }

  beforeEach(() => {
    clock = new ManualClock();
    events = [];
    generators = [];
    loadGenerator = async () => () => {
      const generator = new FakeGenerator();
      generators.push(generator);
      return generator;
    };
    engine = createEngine();
  });

  async function startRun(runId = 1, s: ProducerSettings = settings): Promise<void> {
    await engine.handle({ type: 'init', wasmUrl: 'producer.wasm' });
    await engine.handle({ type: 'start', runId, settings: s });
  }

  it('reports readiness and starts generating batches at the requested interval', async () => {
    await startRun();
    expect(events.slice(0, 2)).toEqual([
      { type: 'ready' },
      { type: 'state', runId: 1, state: 'running' },
    ]);

    clock.advance(99);
    expect(snapshots()).toHaveLength(0);
    clock.advance(1);
    expect(lastSnapshot().stats.totalUpdates).toBe(10);

    clock.advance(400);
    expect(lastSnapshot().stats).toMatchObject({ totalUpdates: 50, batches: 5 });
    expect(lastSnapshot().instruments.map((i) => i.volume)).toEqual([25, 25]);
  });

  it('counts every generated trade even when snapshots are throttled', async () => {
    await startRun(1, { instrumentCount: 1, updatesPerBatch: 7, batchIntervalMs: 50 });
    clock.advance(1000);
    // 20 batches but at most one snapshot per 100 ms.
    expect(snapshots().length).toBeLessThanOrEqual(10);
    expect(lastSnapshot().stats.totalUpdates).toBe(140);
    expect(lastSnapshot().instruments[0].volume).toBe(140);
    expect(generators[0].generated).toBe(140);
  });

  it('pauses without generating and resumes without catching up', async () => {
    await startRun();
    clock.advance(300);
    await engine.handle({ type: 'pause', runId: 1 });
    expect(events.at(-1)).toEqual({ type: 'state', runId: 1, state: 'paused' });
    expect(clock.pending).toBe(0);

    clock.advance(10_000);
    expect(generators[0].generated).toBe(30);

    await engine.handle({ type: 'resume', runId: 1 });
    expect(events.at(-1)).toEqual({ type: 'state', runId: 1, state: 'running' });
    clock.advance(100);
    expect(generators[0].generated).toBe(40);
    expect(lastSnapshot().stats.totalUpdates).toBe(40);
  });

  it('flushes throttled data when pausing', async () => {
    await startRun(1, { instrumentCount: 1, updatesPerBatch: 5, batchIntervalMs: 50 });
    clock.advance(150); // batches at 50 (throttled), 100 (posted), 150 (throttled)
    expect(lastSnapshot().stats.totalUpdates).toBe(10);
    await engine.handle({ type: 'pause', runId: 1 });
    expect(lastSnapshot().stats.totalUpdates).toBe(15);
  });

  it('starts a fresh run with a new generator and cleared totals', async () => {
    await startRun(1);
    clock.advance(500);
    await engine.handle({ type: 'pause', runId: 1 });

    await engine.handle({
      type: 'start',
      runId: 2,
      settings: { instrumentCount: 3, updatesPerBatch: 3, batchIntervalMs: 200 },
    });
    expect(generators).toHaveLength(2);
    expect(generators[1].instrumentCount).toBe(3);
    expect(events.at(-1)).toEqual({ type: 'state', runId: 2, state: 'running' });

    clock.advance(200);
    const snapshot = lastSnapshot();
    expect(snapshot.runId).toBe(2);
    expect(snapshot.stats.totalUpdates).toBe(3);
    expect(snapshot.instruments).toHaveLength(3);
    expect(generators[0].generated).toBe(50); // the old run no longer ticks
  });

  it('ignores pause/resume for stale runs', async () => {
    await startRun(2);
    await engine.handle({ type: 'pause', runId: 1 });
    expect(events.filter((e) => e.type === 'state')).toHaveLength(1);
    expect(clock.pending).toBe(1);
  });

  it('processes commands sent before the module finished loading in order', async () => {
    let resolveLoad!: (factory: GeneratorFactory) => void;
    const loaded = new Promise<GeneratorFactory>((resolve) => (resolveLoad = resolve));
    loadGenerator = () => loaded;
    void engine.handle({ type: 'init', wasmUrl: 'x' });
    void engine.handle({ type: 'start', runId: 1, settings });
    const done = engine.handle({ type: 'pause', runId: 1 });

    resolveLoad(() => new FakeGenerator());
    await done;
    expect(events.map((e) => e.type)).toEqual(['ready', 'state', 'state']);
    expect(events.at(-1)).toEqual({ type: 'state', runId: 1, state: 'paused' });
    expect(clock.pending).toBe(0);
  });

  it('reports initialisation failures', async () => {
    loadGenerator = () => Promise.reject(new Error('HTTP 404'));
    await startRun();
    expect(events).toEqual([{ type: 'error', phase: 'init', message: 'HTTP 404' }]);
  });

  it('reports runtime failures and stops the run', async () => {
    loadGenerator = async () => () => {
      const generator = new FakeGenerator();
      generator.generate = () => {
        throw new Error('boom');
      };
      return generator;
    };
    await startRun();
    clock.advance(100);
    expect(events.at(-1)).toEqual({ type: 'error', phase: 'run', runId: 1, message: 'boom' });
    expect(clock.pending).toBe(0);
    expect(engine.activeRunId).toBeNull();
  });

  it('rejects invalid settings', async () => {
    await startRun(1, { instrumentCount: 0, updatesPerBatch: 1.5, batchIntervalMs: 10 });
    expect(events.at(-1)).toMatchObject({ type: 'error', phase: 'run', runId: 1 });
    expect(clock.pending).toBe(0);
  });

  it('releases the run on dispose and ignores later commands', async () => {
    await startRun();
    await engine.handle({ type: 'dispose' });
    expect(clock.pending).toBe(0);
    await engine.handle({ type: 'start', runId: 2, settings });
    expect(engine.activeRunId).toBeNull();
  });
});
