/// <reference lib="webworker" />

import { ProducerEngine } from './producer-engine';
import { ProducerCommand, ProducerEvent } from './producer.models';
import { compileProducerModule, WasmMarketGenerator } from './wasm-market-generator';

const engine = new ProducerEngine({
  post: (event: ProducerEvent) => postMessage(event),
  loadGenerator: async (wasmUrl) => {
    const module = await compileProducerModule(wasmUrl);
    // Validate exports eagerly so a broken module fails during initialisation.
    WasmMarketGenerator.fromModule(module);
    return () => WasmMarketGenerator.fromModule(module);
  },
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0],
});

addEventListener('message', ({ data }: MessageEvent<ProducerCommand>) => {
  void engine.handle(data);
  if (data.type === 'dispose') close();
});
