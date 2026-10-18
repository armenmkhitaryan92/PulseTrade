import { DestroyRef, DOCUMENT, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { emptyMetrics } from './market-aggregator';
import {
  DEFAULT_SETTINGS,
  InstrumentMetrics,
  isValidSettings,
  ProducerCommand,
  ProducerEvent,
  ProducerSettings,
  ProducerStats,
} from './producer.models';

export type ProducerStatus = 'initializing' | 'running' | 'paused' | 'error';

/** Subset of the Worker API used by the service (lets tests substitute a fake). */
export interface ProducerWorker {
  postMessage(message: ProducerCommand): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ProducerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export const PRODUCER_WORKER_FACTORY = new InjectionToken<() => ProducerWorker>(
  'PRODUCER_WORKER_FACTORY',
  {
    providedIn: 'root',
    factory: () => () =>
      new Worker(new URL('./producer.worker', import.meta.url), {
        type: 'module',
      }) as ProducerWorker,
  },
);

export const PRODUCER_WASM_URL = new InjectionToken<string>('PRODUCER_WASM_URL', {
  providedIn: 'root',
  factory: () => new URL('wasm/market-producer.wasm', inject(DOCUMENT).baseURI).href,
});

export const EMPTY_STATS: Readonly<ProducerStats> = {
  totalUpdates: 0,
  batches: 0,
  measuredRate: 0,
  lastBatchMs: 0,
};

/**
 * Application-wide owner of the single producer worker. Being a root singleton,
 * the run (and its running/paused state) survives route navigation.
 */
@Injectable({ providedIn: 'root' })
export class ProducerService {
  private readonly createWorker = inject(PRODUCER_WORKER_FACTORY);
  private readonly wasmUrl = inject(PRODUCER_WASM_URL);
  private worker: ProducerWorker | null = null;

  private readonly _settings = signal<ProducerSettings>({ ...DEFAULT_SETTINGS });
  private readonly _runId = signal(0);
  private readonly _status = signal<ProducerStatus>('initializing');
  private readonly _error = signal<string | null>(null);
  private readonly _instruments = signal<InstrumentMetrics[]>(
    emptyMetrics(DEFAULT_SETTINGS.instrumentCount),
  );
  private readonly _stats = signal<ProducerStats>(EMPTY_STATS);

  readonly settings = this._settings.asReadonly();
  readonly runId = this._runId.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly instruments = this._instruments.asReadonly();
  readonly stats = this._stats.asReadonly();

  constructor() {
    this.startWorker();
    inject(DestroyRef).onDestroy(() => this.disposeWorker());
  }

  /** Starts a new run with `settings`, clearing all values (also resumes if paused). */
  applySettings(settings: ProducerSettings): void {
    if (!isValidSettings(settings)) {
      throw new Error('Invalid producer settings.');
    }
    this._settings.set({ ...settings });
    if (this._status() === 'error' || !this.worker) {
      this.startWorker();
      return;
    }
    this.beginRun();
  }

  pause(): void {
    if (this._status() !== 'running' && this._status() !== 'initializing') return;
    this._status.set('paused');
    this.send({ type: 'pause', runId: this._runId() });
  }

  resume(): void {
    if (this._status() !== 'paused') return;
    this._status.set('running');
    this.send({ type: 'resume', runId: this._runId() });
  }

  togglePause(): void {
    if (this._status() === 'paused') this.resume();
    else this.pause();
  }

  /** Replaces the worker (e.g. after an initialisation error) and starts a fresh run. */
  restart(): void {
    this.startWorker();
  }

  private startWorker(): void {
    this.disposeWorker();
    this._error.set(null);
    this._status.set('initializing');

    let worker: ProducerWorker;
    try {
      worker = this.createWorker();
    } catch (error) {
      this.fail(`Could not start the producer worker: ${(error as Error)?.message ?? error}`);
      this.resetRunState();
      return;
    }
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (this.worker === worker) this.onEvent(data);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (this.worker === worker) {
        this.fail(event.message || 'The producer worker failed to load or crashed.');
      }
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.fail('Received an unreadable message from the producer.');
    };

    worker.postMessage({ type: 'init', wasmUrl: this.wasmUrl });
    this.beginRun();
  }

  private beginRun(): void {
    this.resetRunState();
    if (this._status() !== 'initializing') this._status.set('running');
    this.send({ type: 'start', runId: this._runId(), settings: this._settings() });
  }

  private resetRunState(): void {
    this._runId.update((id) => id + 1);
    this._instruments.set(emptyMetrics(this._settings().instrumentCount));
    this._stats.set(EMPTY_STATS);
  }

  private onEvent(event: ProducerEvent): void {
    switch (event.type) {
      case 'ready':
        return;
      case 'state':
        if (event.runId !== this._runId()) return;
        // An optimistic pause wins over the "running" ack of the start command.
        if (event.state === 'running' && this._status() === 'paused') return;
        this._status.set(event.state);
        return;
      case 'snapshot':
        if (event.runId !== this._runId()) return; // Stale results from a previous run.
        this._instruments.set(event.instruments);
        this._stats.set(event.stats);
        return;
      case 'error':
        if (event.runId !== undefined && event.runId !== this._runId()) return;
        this.fail(
          event.phase === 'init'
            ? `Producer initialisation failed: ${event.message}`
            : `Producer error: ${event.message}`,
        );
        return;
    }
  }

  private fail(message: string): void {
    this._error.set(message);
    this._status.set('error');
  }

  private send(command: ProducerCommand): void {
    this.worker?.postMessage(command);
  }

  private disposeWorker(): void {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = null;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.postMessage({ type: 'dispose' });
    worker.terminate();
  }
}
