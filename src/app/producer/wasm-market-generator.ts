import { RECORD_SIZE } from './market-aggregator';

/** Exports of `wasm/assembly/index.ts`. */
export interface MarketProducerExports {
  memory: WebAssembly.Memory;
  init(instrumentCount: number, seed: number): void;
  generate(count: number): number;
  outputPointer(): number;
  recordSize(): number;
  maxBatchSize(): number;
  maxInstruments(): number;
  instrumentCount(): number;
}

const REQUIRED_FUNCTIONS = [
  'init',
  'generate',
  'outputPointer',
  'recordSize',
  'maxBatchSize',
  'maxInstruments',
  'instrumentCount',
] as const;

/** Source of market updates; implemented by the Wasm generator (and fakes in tests). */
export interface MarketGenerator {
  readonly maxBatchSize: number;
  readonly maxInstruments: number;
  init(instrumentCount: number, seed: number): void;
  /** Returns a view of `count * RECORD_SIZE` values, valid until the next call. */
  generate(count: number): Int32Array;
}

/** Thin, zero-copy adapter over a Wasm producer instance. */
export class WasmMarketGenerator implements MarketGenerator {
  readonly maxBatchSize: number;
  readonly maxInstruments: number;

  constructor(private readonly exports: MarketProducerExports) {
    this.maxBatchSize = exports.maxBatchSize();
    this.maxInstruments = exports.maxInstruments();
  }

  /** Creates a fresh instance (with its own memory and state) from a compiled module. */
  static fromModule(module: WebAssembly.Module): WasmMarketGenerator {
    const instance = new WebAssembly.Instance(module, {});
    return new WasmMarketGenerator(validateExports(instance.exports));
  }

  init(instrumentCount: number, seed: number): void {
    this.exports.init(instrumentCount, seed >>> 0);
  }

  generate(count: number): Int32Array {
    const written = this.exports.generate(count);
    // A fresh view each call stays valid even if linear memory were ever grown.
    return new Int32Array(
      this.exports.memory.buffer,
      this.exports.outputPointer(),
      written * RECORD_SIZE,
    );
  }
}

export function validateExports(exports: WebAssembly.Exports): MarketProducerExports {
  if (!(exports['memory'] instanceof WebAssembly.Memory)) {
    throw new Error('Wasm producer does not export its memory.');
  }
  const missing = REQUIRED_FUNCTIONS.filter((name) => typeof exports[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Wasm producer is missing exports: ${missing.join(', ')}.`);
  }
  const producer = exports as unknown as MarketProducerExports;
  if (producer.recordSize() !== RECORD_SIZE) {
    throw new Error(
      `Wasm producer record size ${producer.recordSize()} does not match expected ${RECORD_SIZE}.`,
    );
  }
  return producer;
}

/** Fetches and compiles the Wasm producer with descriptive errors. */
export async function compileProducerModule(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<WebAssembly.Module> {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('WebAssembly is not supported in this browser.');
  }
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new Error(`Could not download the Wasm producer from ${url}: ${describeError(error)}`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not download the Wasm producer from ${url} (HTTP ${response.status}). ` +
        'Run "npm run build:wasm" and reload.',
    );
  }
  try {
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`The Wasm producer at ${url} is invalid: ${describeError(error)}`);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
