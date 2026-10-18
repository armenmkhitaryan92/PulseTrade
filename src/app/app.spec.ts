import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';
import { ProducerService } from './producer/producer.service';
import { FakeWorker, provideFakeProducerWorker } from './producer/testing';

describe('App navigation', () => {
  let workers: FakeWorker[];

  beforeEach(() => {
    workers = [];
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), provideFakeProducerWorker(workers)],
    });
  });

  it('redirects to the dashboard', async () => {
    const harness = await RouterTestingHarness.create('/');
    expect(TestBed.inject(Router).url).toBe('/dashboard');
    expect(harness.routeNativeElement?.querySelector('table')).not.toBeNull();
  });

  it('preserves the run and paused state across navigation without new producers', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const producer = TestBed.inject(ProducerService);
    await router.navigateByUrl('/dashboard');
    await fixture.whenStable();

    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    producer.pause();

    await router.navigateByUrl('/settings');
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('form')).not.toBeNull();
    await router.navigateByUrl('/dashboard');
    await fixture.whenStable();

    expect(workers).toHaveLength(1);
    expect(producer.runId()).toBe(1);
    expect(producer.status()).toBe('paused');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Paused');
    expect(el.querySelector('[data-testid="header-status"]')?.textContent?.trim()).toBe('paused');
  });
});
