import { Provider } from '@angular/core';
import { RECORD_SIZE } from './market-aggregator';
import { InstrumentMetrics, ProducerCommand, ProducerEvent } from './producer.models';
import { PRODUCER_WASM_URL, PRODUCER_WORKER_FACTORY, ProducerWorker } from './producer.service';

// Test helpers shared by unit tests (not used by application code).

export interface TestUpdate {
  instrument: number;
  priceCents: number;
  tradeQuantity: number;
  bidCents: number;
  askCents: number;
  bidQuantity: number;
  askQuantity: number;
}

/** Encodes updates in the same flat i32 layout the Wasm producer writes. */
export function encodeUpdates(updates: TestUpdate[]): Int32Array {
  const records = new Int32Array(updates.length * RECORD_SIZE);
  updates.forEach((u, k) => {
    records.set(
      [
        u.instrument,
        u.priceCents,
        u.tradeQuantity,
        u.bidCents,
        u.askCents,
        u.bidQuantity,
        u.askQuantity,
      ],
      k * RECORD_SIZE,
    );
  });
  return records;
}

export class FakeWorker implements ProducerWorker {
  readonly sent: ProducerCommand[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<ProducerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  postMessage(message: ProducerCommand): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: ProducerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<ProducerEvent>);
  }

  fail(message: string): void {
    this.onerror?.({ message, preventDefault: () => undefined } as ErrorEvent);
  }
}

export function provideFakeProducerWorker(workers: FakeWorker[]): Provider[] {
  return [
    {
      provide: PRODUCER_WORKER_FACTORY,
      useValue: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    },
    { provide: PRODUCER_WASM_URL, useValue: 'http://test/wasm/market-producer.wasm' },
  ];
}

export function metric(
  index: number,
  overrides: Partial<InstrumentMetrics> = {},
): InstrumentMetrics {
  return {
    index,
    symbol: `S${index}`,
    lastPriceCents: 10200,
    spreadCents: 4,
    volume: 40,
    vwapCents: 10150,
    imbalance: 0.2,
    tradeCount: 2,
    ...overrides,
  };
}
