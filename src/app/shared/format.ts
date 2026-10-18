/** Placeholder for values that are not available (no data or zero denominator). */
export const UNAVAILABLE = '—';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const decimal = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Formats a cent amount as dollars; rounding happens only here. */
export function formatCents(cents: number | null): string {
  return cents === null || !Number.isFinite(cents) ? UNAVAILABLE : currency.format(cents / 100);
}

/** Formats an order-book imbalance in [−1, +1] with an explicit sign. */
export function formatImbalance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE;
  const clamped = Math.max(-1, Math.min(1, value));
  const rounded = Math.round(clamped * 100) / 100;
  if (rounded === 0) return '0.00';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)}`;
}

export function formatInteger(value: number): string {
  return integer.format(value);
}

export function formatDecimal(value: number): string {
  return decimal.format(value);
}
