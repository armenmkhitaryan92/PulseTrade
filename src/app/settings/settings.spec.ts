import { TestBed } from '@angular/core/testing';
import { ProducerService } from '../producer/producer.service';
import { FakeWorker, provideFakeProducerWorker } from '../producer/testing';
import { Settings } from './settings';

describe('Settings', () => {
  let workers: FakeWorker[];
  let producer: ProducerService;

  async function render() {
    const fixture = TestBed.createComponent(Settings);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const input = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!;
    const applyButton = () => el.querySelector<HTMLButtonElement>('[data-testid="apply"]')!;
    const type = async (id: string, value: string) => {
      input(id).value = value;
      input(id).dispatchEvent(new Event('input'));
      input(id).dispatchEvent(new Event('blur'));
      await fixture.whenStable();
    };
    return { fixture, el, input, applyButton, type };
  }

  beforeEach(() => {
    workers = [];
    TestBed.configureTestingModule({
      imports: [Settings],
      providers: [provideFakeProducerWorker(workers)],
    });
    producer = TestBed.inject(ProducerService);
  });

  it('starts from the active settings and shows the nominal rate', async () => {
    const { el, input } = await render();
    expect(input('instrumentCount').value).toBe('5');
    expect(input('updatesPerBatch').value).toBe('100');
    expect(input('batchIntervalMs').value).toBe('500');
    expect(el.querySelector('[data-testid="preview"]')?.textContent).toContain(
      '200 updates/s across all instruments',
    );
  });

  it.each([
    ['instrumentCount', '0', 'Must be between 1 and 50.'],
    ['instrumentCount', '51', 'Must be between 1 and 50.'],
    ['updatesPerBatch', '1001', 'Must be between 1 and 1000.'],
    ['batchIntervalMs', '49', 'Must be between 50 and 2000.'],
    ['batchIntervalMs', '2001', 'Must be between 50 and 2000.'],
    ['updatesPerBatch', '2.5', 'Must be a whole number.'],
    ['instrumentCount', '', 'A value is required.'],
  ])('rejects %s = "%s"', async (id, value, message) => {
    const { el, applyButton, type } = await render();
    await type(id, value);
    expect(el.querySelector(`[data-testid="${id}-error"]`)?.textContent?.trim()).toBe(message);
    expect(applyButton().disabled).toBe(true);
  });

  it('accepts boundary values', async () => {
    const { applyButton, type } = await render();
    await type('instrumentCount', '50');
    await type('updatesPerBatch', '1');
    await type('batchIntervalMs', '2000');
    expect(applyButton().disabled).toBe(false);
  });

  it('does not affect the producer until Apply', async () => {
    const { el, applyButton, type } = await render();
    const sentBefore = workers[0].sent.length;
    await type('instrumentCount', '3');
    await type('updatesPerBatch', '10');
    await type('batchIntervalMs', '50');

    expect(workers[0].sent).toHaveLength(sentBefore);
    expect(producer.settings().instrumentCount).toBe(5);
    expect(el.querySelector('[data-testid="preview"]')?.textContent).toContain('200 updates/s');

    applyButton().click();
    expect(producer.settings()).toEqual({
      instrumentCount: 3,
      updatesPerBatch: 10,
      batchIntervalMs: 50,
    });
    expect(workers[0].sent.at(-1)).toEqual({
      type: 'start',
      runId: 2,
      settings: { instrumentCount: 3, updatesPerBatch: 10, batchIntervalMs: 50 },
    });
  });

  it('apply restarts generation when paused', async () => {
    workers[0].emit({ type: 'state', runId: 1, state: 'running' });
    producer.pause();
    const { applyButton } = await render();
    applyButton().click();
    expect(producer.status()).toBe('running');
    expect(producer.runId()).toBe(2);
  });

  it('resets the form to defaults without applying', async () => {
    const { el, input, type } = await render();
    await type('instrumentCount', '9');
    const reset = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset to defaults'),
    )!;
    reset.click();
    expect(input('instrumentCount').value).toBe('5');
    expect(producer.runId()).toBe(1);
  });
});
