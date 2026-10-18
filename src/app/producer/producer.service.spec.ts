import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ProducerEvent } from './producer.models';
import { ProducerService } from './producer.service';
import { FakeWorker, metric, provideFakeProducerWorker } from './testing';

const stats = { totalUpdates: 40, batches: 1, measuredRate: 80, lastBatchMs: 0.5 };

describe('ProducerService', () => {
  let workers: FakeWorker[];
  let service: ProducerService;

  beforeEach(() => {
    workers = [];
    TestBed.configureTestingModule({ providers: provideFakeProducerWorker(workers) });
    service = TestBed.inject(ProducerService);
  });

  it('creates one worker and starts the default run', () => {
    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toEqual([
      { type: 'init', wasmUrl: 'http://test/wasm/market-producer.wasm' },
      {
        type: 'start',
        runId: 1,
        settings: { instrumentCount: 5, updatesPerBatch: 100, batchIntervalMs: 500 },
      },
    ]);
    expect(service.status()).toBe('initializing');
    expect(service.instruments()).toHaveLength(5);
    expect(service.instruments().every((i) => i.volume === 0 && i.lastPriceCents === null)).toBe(
      true,
    );
  });

  it('is a singleton: injecting again does not create another worker', () => {
    TestBed.inject(ProducerService);
    expect(workers).toHaveLength(1);
  });

  it('applies snapshots for the current run', () => {
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    workers[0].emit({ type: 'snapshot', runId: 1, instruments: [metric(0)], stats });
    expect(service.status()).toBe('running');
    expect(service.instruments()).toEqual([metric(0)]);
    expect(service.stats()).toEqual(stats);
  });

  it('pauses and resumes the current run', () => {
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    service.togglePause();
    expect(service.status()).toBe('paused');
    expect(workers[0].sent.at(-1)).toEqual({ type: 'pause', runId: 1 });

    service.togglePause();
    expect(service.status()).toBe('running');
    expect(workers[0].sent.at(-1)).toEqual({ type: 'resume', runId: 1 });
  });

  it('keeps an optimistic pause when the start acknowledgement arrives late', () => {
    service.pause();
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    expect(service.status()).toBe('paused');
  });

  it('starts a new run on apply, clearing values and resuming if paused', () => {
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    workers[0].emit({ type: 'snapshot', runId: 1, instruments: [metric(0)], stats });
    service.pause();

    const next = { instrumentCount: 3, updatesPerBatch: 10, batchIntervalMs: 50 };
    service.applySettings(next);

    expect(workers).toHaveLength(1);
    expect(workers[0].sent.at(-1)).toEqual({ type: 'start', runId: 2, settings: next });
    expect(service.runId()).toBe(2);
    expect(service.settings()).toEqual(next);
    expect(service.status()).toBe('running');
    expect(service.instruments()).toHaveLength(3);
    expect(service.instruments().every((i) => i.volume === 0)).toBe(true);
    expect(service.stats().totalUpdates).toBe(0);
  });

  it('ignores results from a previous run', () => {
    service.applySettings({ instrumentCount: 2, updatesPerBatch: 10, batchIntervalMs: 100 });
    workers[0].emit({
      type: 'snapshot',
      runId: 1,
      instruments: [metric(0, { volume: 999 })],
      stats,
    });
    workers[0].emit({ type: 'state', runId: 1, state: 'paused' });
    workers[0].emit({ type: 'error', phase: 'run', runId: 1, message: 'old' });

    expect(service.instruments().map((i) => i.volume)).toEqual([0, 0]);
    expect(service.status()).not.toBe('paused');
    expect(service.error()).toBeNull();
  });

  it('rejects invalid settings without touching the run', () => {
    expect(() =>
      service.applySettings({ instrumentCount: 51, updatesPerBatch: 1, batchIntervalMs: 50 }),
    ).toThrow();
    expect(service.runId()).toBe(1);
  });

  it('surfaces initialisation errors and recovers with a new worker on retry', () => {
    workers[0].emit({ type: 'error', phase: 'init', message: 'HTTP 404' });
    expect(service.status()).toBe('error');
    expect(service.error()).toContain('HTTP 404');

    service.restart();
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].sent.at(-1)).toEqual({ type: 'dispose' });
    expect(workers).toHaveLength(2);
    expect(service.status()).toBe('initializing');
    expect(service.error()).toBeNull();
    expect(service.runId()).toBe(2);
  });

  it('surfaces worker script errors and ignores events from replaced workers', () => {
    workers[0].fail('Failed to fetch worker');
    expect(service.status()).toBe('error');
    expect(service.error()).toBe('Failed to fetch worker');

    const old = workers[0];
    const oldOnMessage = old.onmessage;
    service.applySettings({ instrumentCount: 1, updatesPerBatch: 1, batchIntervalMs: 50 });
    expect(workers).toHaveLength(2);
    expect(old.onmessage).toBeNull();
    oldOnMessage?.({
      data: { type: 'snapshot', runId: 2, instruments: [metric(0)], stats },
    } as MessageEvent<ProducerEvent>);
    expect(service.instruments()[0].volume).toBe(0);
  });

  it('terminates the worker when the application is destroyed', () => {
    TestBed.inject(ApplicationRef);
    TestBed.resetTestingModule();
    expect(workers[0].terminated).toBe(true);
  });
});
