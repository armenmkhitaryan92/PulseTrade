import { RouterLink } from '@angular/router';
import { nominalRate } from '../producer/producer.models';
import { Component, computed, inject } from '@angular/core';
import { ProducerService } from '../producer/producer.service';
import { formatCents, formatDecimal, formatImbalance, formatInteger } from '../shared/format';

export interface DashboardRow {
  index: number;
  symbol: string;
  lastPrice: string;
  spread: string;
  volume: string;
  vwap: string;
  imbalance: string;
  imbalanceSign: 'positive' | 'negative' | 'neutral';
}

const STATUS_LABELS = {
  initializing: 'Initialising',
  running: 'Running',
  paused: 'Paused',
  error: 'Error',
} as const;

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  protected readonly producer = inject(ProducerService);

  protected readonly statusLabel = computed(() => STATUS_LABELS[this.producer.status()]);

  protected readonly rows = computed<DashboardRow[]>(() =>
    this.producer.instruments().map((m) => ({
      index: m.index,
      symbol: m.symbol,
      lastPrice: formatCents(m.lastPriceCents),
      spread: formatCents(m.spreadCents),
      volume: formatInteger(m.volume),
      vwap: formatCents(m.vwapCents),
      imbalance: formatImbalance(m.imbalance),
      imbalanceSign:
        m.imbalance === null || m.imbalance === 0
          ? 'neutral'
          : m.imbalance > 0
            ? 'positive'
            : 'negative',
    }))
  );

  protected readonly summary = computed(() => {
    const stats = this.producer.stats();
    const settings = this.producer.settings();

    return {
      nominalRate: formatInteger(nominalRate(settings)),
      measuredRate: this.producer.status() === 'running' ? formatInteger(stats.measuredRate) : '0',
      totalUpdates: formatInteger(stats.totalUpdates),
      batches: formatInteger(stats.batches),
      lastBatchMs: formatDecimal(stats.lastBatchMs),
    };
  });

  protected readonly canToggle = computed(() => this.producer.status() !== 'error');
}
