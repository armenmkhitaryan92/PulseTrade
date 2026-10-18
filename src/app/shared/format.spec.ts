import { formatCents, formatImbalance, formatInteger, UNAVAILABLE } from './format';

describe('format helpers', () => {
  it('formats cents as currency and rounds only for display', () => {
    expect(formatCents(10200)).toBe('$102.00');
    expect(formatCents(10150)).toBe('$101.50');
    expect(formatCents(4)).toBe('$0.04');
    expect(formatCents(10150.4999)).toBe('$101.50');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  it('shows unavailable values', () => {
    expect(formatCents(null)).toBe(UNAVAILABLE);
    expect(formatImbalance(null)).toBe(UNAVAILABLE);
    expect(formatCents(Number.NaN)).toBe(UNAVAILABLE);
  });

  it('formats imbalance as a signed value between −1 and +1', () => {
    expect(formatImbalance(0.2)).toBe('+0.20');
    expect(formatImbalance(-0.5)).toBe('−0.50');
    expect(formatImbalance(0)).toBe('0.00');
    expect(formatImbalance(-0.001)).toBe('0.00');
    expect(formatImbalance(1)).toBe('+1.00');
    expect(formatImbalance(-1)).toBe('−1.00');
  });

  it('formats integers with grouping', () => {
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(1234567)).toBe('1,234,567');
  });
});
