import { formatInteger } from '../shared/format';
import { toSignal } from '@angular/core/rxjs-interop';
import { ProducerService } from '../producer/producer.service';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import {
  DEFAULT_SETTINGS,
  nominalRate,
  ProducerSettings,
  SETTING_LIMITS,
} from '../producer/producer.models';

export function integerValidator(control: AbstractControl): ValidationErrors | null {
  const value = control.value;
  if (value === null || value === '') return null; // handled by `required`
  return Number.isInteger(value) ? null : { integer: true };
}

function settingValidators(key: keyof ProducerSettings) {
  const { min, max } = SETTING_LIMITS[key];
  return [Validators.required, integerValidator, Validators.min(min), Validators.max(max)];
}

interface FieldConfig {
  key: keyof ProducerSettings;
  label: string;
  description: string;
  unit?: string;
}

@Component({
  selector: 'app-settings',
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  imports: [ReactiveFormsModule],
})
export class Settings {
  private readonly producer = inject(ProducerService);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly limits = SETTING_LIMITS;
  protected readonly fields: FieldConfig[] = [
    {
      key: 'instrumentCount',
      label: 'Instrument count',
      description: 'Number of fictional instruments to generate data for.',
    },
    {
      key: 'updatesPerBatch',
      label: 'Updates per batch',
      description: 'Total market updates in each batch, across all instruments.',
    },
    {
      key: 'batchIntervalMs',
      label: 'Batch interval',
      description: 'Requested time between batches.',
      unit: 'ms',
    },
  ];

  // Edits stay local to the form until Apply; the form starts from the active settings.
  protected readonly form = this.fb.group({
    instrumentCount: [
      this.producer.settings().instrumentCount,
      settingValidators('instrumentCount'),
    ],
    updatesPerBatch: [
      this.producer.settings().updatesPerBatch,
      settingValidators('updatesPerBatch'),
    ],
    batchIntervalMs: [
      this.producer.settings().batchIntervalMs,
      settingValidators('batchIntervalMs'),
    ],
  });

  private readonly formValue = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });
  private readonly formStatus = toSignal(this.form.statusChanges, {
    initialValue: this.form.status,
  });

  protected readonly appliedRunId = signal<number | null>(null);
  protected readonly activeSettings = this.producer.settings;

  protected readonly previewRate = computed(() => {
    if (this.formStatus() !== 'VALID') return null;

    return formatInteger(nominalRate(this.formValue() as ProducerSettings));
  });

  protected errorFor(key: keyof ProducerSettings): string | null {
    const control = this.form.controls[key];

    if (!control.errors || !(control.touched || control.dirty)) return null;

    const { min, max } = SETTING_LIMITS[key];

    if (control.errors['required']) return 'A value is required.';
    if (control.errors['integer']) return 'Must be a whole number.';
    if (control.errors['min'] || control.errors['max']) return `Must be between ${min} and ${max}.`;

    return 'Invalid value.';
  }

  protected apply(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.producer.applySettings(this.form.getRawValue());
    this.form.markAsPristine();

    this.appliedRunId.set(this.producer.runId());
  }

  protected resetToDefaults(): void {
    this.form.setValue({ ...DEFAULT_SETTINGS });
    this.form.markAsDirty();
  }

  protected discardChanges(): void {
    this.form.reset(this.producer.settings());
  }
}
