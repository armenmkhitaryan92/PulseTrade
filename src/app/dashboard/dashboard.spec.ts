import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProducerService } from '../producer/producer.service';
import { FakeWorker, metric, provideFakeProducerWorker } from '../producer/testing';
import { Dashboard } from './dashboard';

describe('Dashboard', () => {
  let workers: FakeWorker[];

  async function render() {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const cells = (el: HTMLElement, row = 0) =>
    Array.from(el.querySelectorAll('[data-testid="row"]')[row].querySelectorAll('th, td')).map(
      (c) => c.textContent?.trim(),
    );

  beforeEach(() => {
    workers = [];
    TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [provideRouter([]), provideFakeProducerWorker(workers)],
    });
  });

  it('shows one row per instrument with unavailable values and zero volume before data', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('[data-testid="row"]')).toHaveLength(5);
    expect(cells(el)).toEqual(['ALFA', '—', '—', '0', '—', '—']);
  });

  it('renders formatted metrics from the producer', async () => {
    const { fixture, el } = await render();
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    workers[0].emit({
      type: 'snapshot',
      runId: 1,
      instruments: [
        metric(0, { symbol: 'ALFA' }),
        metric(1, { symbol: 'BETA', imbalance: -0.5, volume: 1234567, vwapCents: 9999.6 }),
      ],
      stats: { totalUpdates: 1234607, batches: 3, measuredRate: 200, lastBatchMs: 0.25 },
    });
    await fixture.whenStable();

    expect(cells(el, 0)).toEqual(['ALFA', '$102.00', '$0.04', '40', '$101.50', '+0.20']);
    expect(cells(el, 1)).toEqual(['BETA', '$102.00', '$0.04', '1,234,567', '$100.00', '−0.50']);
    expect(el.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Running');
    expect(el.querySelector('[data-testid="total-updates"]')?.textContent?.trim()).toBe(
      '1,234,607',
    );
  });

  it('toggles pause and resume', async () => {
    const { fixture, el } = await render();
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    await fixture.whenStable();

    const button = el.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!;
    expect(button.textContent?.trim()).toBe('Pause');
    button.click();
    await fixture.whenStable();
    expect(button.textContent?.trim()).toBe('Resume');
    expect(el.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Paused');
    expect(workers[0].sent.at(-1)).toEqual({ type: 'pause', runId: 1 });

    button.click();
    await fixture.whenStable();
    expect(button.textContent?.trim()).toBe('Pause');
    expect(workers[0].sent.at(-1)).toEqual({ type: 'resume', runId: 1 });
  });

  it('shows initialisation errors with a retry action', async () => {
    const { fixture, el } = await render();
    workers[0].emit({ type: 'error', phase: 'init', message: 'HTTP 404' });
    await fixture.whenStable();

    const alert = el.querySelector('[data-testid="error"]');
    expect(alert?.textContent).toContain('Producer initialisation failed: HTTP 404');
    expect(el.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!.disabled).toBe(true);

    alert!.querySelector('button')!.click();
    await fixture.whenStable();
    expect(workers).toHaveLength(2);
    expect(el.querySelector('[data-testid="error"]')).toBeNull();
    expect(TestBed.inject(ProducerService).status()).toBe('initializing');
  });
});
