/** Producer settings chosen on the Settings page. */
export interface ProducerSettings {
  instrumentCount: number;
  updatesPerBatch: number;
  batchIntervalMs: number;
}

export interface SettingLimits {
  min: number;
  max: number;
}

export const SETTING_LIMITS: Readonly<Record<keyof ProducerSettings, SettingLimits>> = {
  instrumentCount: { min: 1, max: 50 },
  updatesPerBatch: { min: 1, max: 1000 },
  batchIntervalMs: { min: 50, max: 2000 },
};

export const DEFAULT_SETTINGS: Readonly<ProducerSettings> = {
  instrumentCount: 5,
  updatesPerBatch: 100,
  batchIntervalMs: 500,
};

/** Nominal update rate across all instruments (updates per second). */
export function nominalRate(settings: ProducerSettings): number {
  return (settings.updatesPerBatch * 1000) / settings.batchIntervalMs;
}

export function isValidSettings(settings: ProducerSettings): boolean {
  return (Object.keys(SETTING_LIMITS) as (keyof ProducerSettings)[]).every((key) => {
    const value = settings[key];
    const { min, max } = SETTING_LIMITS[key];
    return Number.isInteger(value) && value >= min && value <= max;
  });
}

/**
 * Metrics for one instrument, calculated in the worker from every generated
 * update. Prices are in cents; `null` means "not available" (no data yet or a
 * zero denominator).
 */
export interface InstrumentMetrics {
  index: number;
  symbol: string;
  lastPriceCents: number | null;
  spreadCents: number | null;
  volume: number;
  /** May be fractional; rounded only for display. */
  vwapCents: number | null;
  imbalance: number | null;
  tradeCount: number;
}

export interface ProducerStats {
  totalUpdates: number;
  batches: number;
  /** Measured updates/s since the previous snapshot. */
  measuredRate: number;
  /** Wall time spent generating + aggregating the last batch (ms). */
  lastBatchMs: number;
}

export type RunState = 'running' | 'paused';

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

export type ProducerCommand =
  | { type: 'init'; wasmUrl: string }
  | { type: 'start'; runId: number; settings: ProducerSettings }
  | { type: 'pause'; runId: number }
  | { type: 'resume'; runId: number }
  | { type: 'dispose' };

export type ProducerEvent =
  | { type: 'ready' }
  | { type: 'state'; runId: number; state: RunState }
  | { type: 'snapshot'; runId: number; instruments: InstrumentMetrics[]; stats: ProducerStats }
  | { type: 'error'; phase: 'init' | 'run'; message: string; runId?: number };
