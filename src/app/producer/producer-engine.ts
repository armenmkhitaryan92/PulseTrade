import { MarketAggregator, RECORD_SIZE } from './market-aggregator';
import {
  isValidSettings,
  ProducerCommand,
  ProducerEvent,
  ProducerSettings,
  RunState,
} from './producer.models';
import { describeError, MarketGenerator } from './wasm-market-generator';

export type GeneratorFactory = () => MarketGenerator;

export interface EngineDeps {
  post(event: ProducerEvent): void;
  /** Loads/compiles the producer once; the factory creates a fresh generator per run. */
  loadGenerator(wasmUrl: string): Promise<GeneratorFactory>;
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  randomSeed(): number;
  /** Minimum time between snapshots posted to the UI thread. */
  snapshotIntervalMs?: number;
}

interface ActiveRun {
  readonly id: number;
  readonly settings: ProducerSettings;
  readonly generator: MarketGenerator;
  readonly aggregator: MarketAggregator;
  state: RunState;
  timer: unknown;
  nextAt: number;
  totalUpdates: number;
  batches: number;
  lastBatchMs: number;
  lastPostAt: number;
  updatesSincePost: number;
  dirty: boolean;
}

export const DEFAULT_SNAPSHOT_INTERVAL_MS = 100;

/**
 * Runs inside the Web Worker: schedules batches, pulls updates from the Wasm
 * generator, aggregates them and posts throttled snapshots tagged with a run id.
 * Independent of worker globals so it can be unit tested.
 */
export class ProducerEngine {
  private factory: Promise<GeneratorFactory> | null = null;
  private run: ActiveRun | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly snapshotIntervalMs: number;

  constructor(private readonly deps: EngineDeps) {
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  }

  /** Commands are processed strictly in order, even while the module is still loading. */
  handle(command: ProducerCommand): Promise<void> {
    this.queue = this.queue.then(() => this.process(command)).catch(() => undefined);
    return this.queue;
  }

  get activeRunId(): number | null {
    return this.run?.id ?? null;
  }

  private async process(command: ProducerCommand): Promise<void> {
    if (this.disposed) return;
    switch (command.type) {
      case 'init':
        return this.init(command.wasmUrl);
      case 'start':
        return this.start(command.runId, command.settings);
      case 'pause':
        return this.pause(command.runId);
      case 'resume':
        return this.resume(command.runId);
      case 'dispose':
        this.disposed = true;
        this.stopRun();
        this.factory = null;
        return;
    }
  }

  private async init(wasmUrl: string): Promise<void> {
    this.factory = this.deps.loadGenerator(wasmUrl);
    try {
      await this.factory;
      this.deps.post({ type: 'ready' });
    } catch (error) {
      this.deps.post({ type: 'error', phase: 'init', message: describeError(error) });
    }
  }

  private async start(runId: number, settings: ProducerSettings): Promise<void> {
    this.stopRun();
    if (!this.factory) {
      this.deps.post({
        type: 'error',
        phase: 'init',
        runId,
        message: 'Producer was started before it was initialised.',
      });
      return;
    }
    let factory: GeneratorFactory;
    try {
      factory = await this.factory;
    } catch {
      return; // Already reported by init().
    }
    if (!isValidSettings(settings)) {
      this.deps.post({
        type: 'error',
        phase: 'run',
        runId,
        message: `Invalid producer settings: ${JSON.stringify(settings)}`,
      });
      return;
    }

    try {
      const generator = factory();
      if (
        settings.instrumentCount > generator.maxInstruments ||
        settings.updatesPerBatch > generator.maxBatchSize
      ) {
        throw new Error('Settings exceed the limits supported by the Wasm producer.');
      }
      generator.init(settings.instrumentCount, this.deps.randomSeed());
      const now = this.deps.now();
      this.run = {
        id: runId,
        settings: { ...settings },
        generator,
        aggregator: new MarketAggregator(settings.instrumentCount),
        state: 'running',
        timer: null,
        nextAt: now + settings.batchIntervalMs,
        totalUpdates: 0,
        batches: 0,
        lastBatchMs: 0,
        lastPostAt: now,
        updatesSincePost: 0,
        dirty: false,
      };
    } catch (error) {
      this.deps.post({ type: 'error', phase: 'run', runId, message: describeError(error) });
      return;
    }
    this.deps.post({ type: 'state', runId, state: 'running' });
    this.schedule(this.run);
  }

  private pause(runId: number): void {
    const run = this.run;
    if (!run || run.id !== runId || run.state !== 'running') return;
    run.state = 'paused';
    this.clearTimer(run);
    if (run.dirty) this.postSnapshot(run);
    this.deps.post({ type: 'state', runId, state: 'paused' });
  }

  private resume(runId: number): void {
    const run = this.run;
    if (!run || run.id !== runId || run.state !== 'paused') return;
    const now = this.deps.now();
    run.state = 'running';
    // No catch-up: the paused interval produces no data.
    run.nextAt = now + run.settings.batchIntervalMs;
    run.lastPostAt = now;
    run.updatesSincePost = 0;
    this.deps.post({ type: 'state', runId, state: 'running' });
    this.schedule(run);
  }

  private schedule(run: ActiveRun): void {
    const delay = Math.max(0, run.nextAt - this.deps.now());
    run.timer = this.deps.setTimer(() => this.tick(run), delay);
  }

  private tick(run: ActiveRun): void {
    if (this.run !== run || run.state !== 'running') return;
    run.timer = null;
    const started = this.deps.now();
    try {
      const records = run.generator.generate(run.settings.updatesPerBatch);
      const count = records.length / RECORD_SIZE;
      run.aggregator.ingest(records, count);
      run.totalUpdates += count;
      run.updatesSincePost += count;
      run.batches += 1;
    } catch (error) {
      this.deps.post({ type: 'error', phase: 'run', runId: run.id, message: describeError(error) });
      this.stopRun();
      return;
    }
    const now = this.deps.now();
    run.lastBatchMs = now - started;

    if (now - run.lastPostAt >= this.snapshotIntervalMs) {
      this.postSnapshot(run);
    } else {
      run.dirty = true;
    }

    // Keep a steady cadence; if we fell behind, skip rather than burst.
    run.nextAt += run.settings.batchIntervalMs;
    if (run.nextAt <= now) run.nextAt = now + run.settings.batchIntervalMs;
    this.schedule(run);
  }

  private postSnapshot(run: ActiveRun): void {
    const now = this.deps.now();
    const elapsedSeconds = (now - run.lastPostAt) / 1000;
    this.deps.post({
      type: 'snapshot',
      runId: run.id,
      instruments: run.aggregator.snapshot(),
      stats: {
        totalUpdates: run.totalUpdates,
        batches: run.batches,
        measuredRate: elapsedSeconds > 0 ? run.updatesSincePost / elapsedSeconds : 0,
        lastBatchMs: run.lastBatchMs,
      },
    });
    run.lastPostAt = now;
    run.updatesSincePost = 0;
    run.dirty = false;
  }

  private clearTimer(run: ActiveRun): void {
    if (run.timer !== null) {
      this.deps.clearTimer(run.timer);
      run.timer = null;
    }
  }

  /** Releases the current run (timer + Wasm instance) so it can be garbage collected. */
  private stopRun(): void {
    if (this.run) {
      this.clearTimer(this.run);
      this.run = null;
    }
  }
}
